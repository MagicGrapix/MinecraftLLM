import { setImmediate as yieldToEvents } from "node:timers/promises";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { FindBlocksOptions } from "./types";
import { checkQueryBudget, QUERY_LIMITS } from "./queries/QueryLimits";

/** Search loaded cells in nearest sections first; never calls synchronous findBlocks. */
export async function findBlocksCooperatively(bot: Bot, ids: ReadonlySet<number>, options: FindBlocksOptions): Promise<Block[]> {
  const radius = options.maxDistance ?? 32, count = options.count ?? 1;
  if (!Number.isFinite(radius) || radius <= 0 || radius > QUERY_LIMITS.maxBlockRadius ||
      !Number.isInteger(count) || count < 1 || count > 128) throw new Error("Invalid block search radius/count.");
  const context = { signal: options.signal, deadline: options.deadline ?? performance.now() + QUERY_LIMITS.timeoutMs };
  checkQueryBudget(context);
  const origin = bot.entity.position.clone();
  const dimension = bot.game.dimension;
  const min = new Vec3(Math.ceil(origin.x - radius), Math.ceil(origin.y - radius), Math.ceil(origin.z - radius));
  const max = origin.offset(radius, radius, radius).floor();
  // Mineflayer populates these fields at login, but its GameState types omit them.
  const dimensions = bot.game as typeof bot.game & { minY?: number; height?: number };
  if (dimensions.minY !== undefined && dimensions.height !== undefined) {
    min.y = Math.max(min.y, dimensions.minY);
    max.y = Math.min(max.y, dimensions.minY + dimensions.height - 1);
  }
  const sections: { min: Vec3; max: Vec3; distance: number }[] = [];
  for (let x = Math.floor(min.x / 16); x <= Math.floor(max.x / 16); x++) {
    for (let z = Math.floor(min.z / 16); z <= Math.floor(max.z / 16); z++) {
      if (!bot.world.getColumn(x, z)) continue;
      for (let y = Math.floor(min.y / 16); y <= Math.floor(max.y / 16); y++) {
        const lo = new Vec3(Math.max(min.x, x * 16), Math.max(min.y, y * 16), Math.max(min.z, z * 16));
        const hi = new Vec3(Math.min(max.x, x * 16 + 15), Math.min(max.y, y * 16 + 15), Math.min(max.z, z * 16 + 15));
        const nearest = new Vec3(Math.max(lo.x, Math.min(hi.x, origin.x)), Math.max(lo.y, Math.min(hi.y, origin.y)), Math.max(lo.z, Math.min(hi.z, origin.z)));
        const distance = nearest.distanceSquared(origin);
        if (distance <= radius * radius) sections.push({ min: lo, max: hi, distance });
      }
    }
  }
  sections.sort((a, b) => a.distance - b.distance);
  const found: { block: Block; distance: number }[] = [];
  let cells = 0;
  const cutoff = () => found.length === count ? found[found.length - 1]!.distance : radius * radius;
  for (const section of sections) {
    if (section.distance > cutoff()) break;
    for (let y = section.min.y; y <= section.max.y; y++) {
      for (let z = section.min.z; z <= section.max.z; z++) {
        for (let x = section.min.x; x <= section.max.x; x++) {
          if (++cells % 1024 === 0) {
            await yieldToEvents();
            checkQueryBudget(context);
            if (bot.game.dimension !== dimension) throw new Error("World dimension changed during block search.");
          }
          const position = new Vec3(x, y, z), distance = position.distanceSquared(origin);
          if (distance > cutoff()) continue;
          const block = bot.blockAt(position, false);
          if (!block || !ids.has(block.type)) continue;
          found.push({ block, distance });
          found.sort((a, b) => a.distance - b.distance || a.block.position.x - b.block.position.x || a.block.position.y - b.block.position.y || a.block.position.z - b.block.position.z);
          if (found.length > count) found.pop();
        }
      }
    }
  }
  checkQueryBudget(context);
  // Cells can change while yielding; never return a block that is no longer observed.
  return found.map(({ block }) => bot.blockAt(block.position, false))
    .filter((block): block is Block => block !== null && ids.has(block.type));
}
