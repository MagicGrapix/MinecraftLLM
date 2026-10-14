import type { Bot } from "mineflayer";
import { fromVec3, toVec3 } from "../runtime/PositionAdapter";
import type { Position } from "../shared/types";

/** Pick a standable cell near the landing surface, not the item's airborne coordinates. */
export function pickupPosition(bot: Bot, drop: Position): Position | null {
  const cell = toVec3(drop).floored();
  for (let depth = 0; depth <= 4; depth++) {
    const block = bot.blockAt(cell.offset(0, -depth, 0));
    if (!block || block.name === "water" || block.name === "lava") return null;
    if (block.boundingBox !== "block") continue;
    const feet = block.position.offset(0, 1, 0);
    const distance = (p: typeof feet) => Math.hypot(p.x + 0.5 - drop.x, p.z + 0.5 - drop.z);
    const candidates = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => feet.offset(x!, 0, z!));
    const target = candidates.filter(p => {
      const support = bot.blockAt(p.offset(0, -1, 0));
      return distance(p) <= 1.15 && support?.shapes.length === 1 &&
        support.shapes[0]!.every((n, i) => n === (i < 3 ? 0 : 1)) &&
        [p, p.offset(0, 1, 0)].every(at => {
          const b = bot.blockAt(at);
          return b?.boundingBox === "empty" && b.name !== "water" && b.name !== "lava";
        });
    }).sort((a, b) => distance(a) - distance(b))[0];
    return target ? fromVec3(target) : null;
  }
  return null;
}
