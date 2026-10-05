import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { PartiallyComputedPath } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

export function isPassableOpenDoor(block: Block | null): boolean {
  return !!block?.name?.endsWith("_door") && block.getProperties().open === true &&
    !block.shapes.some(s => s[0] < 0.8 && s[3] > 0.2 && s[2] < 0.8 && s[5] > 0.2 && s[1] < 1 && s[4] > 0);
}

/** Pathfinder 2.4.x post-processing tries to stand ON any nonempty shape.
 * Its open-door waypoint is consequently one block too high and offset towards
 * the hinge. Correct only that recognised two-half case, before path consumption.
 * World blocks and physics collision shapes remain untouched.
 */
export function correctOpenDoorWaypoints(bot: Bot, update: PartiallyComputedPath): void {
  if (update.status !== "success" && update.status !== "partial") return;
  for (const point of update.path ?? []) {
    if (point.toBreak.length || point.toPlace.length) continue;
    const position = new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
    const upper = bot.blockAt(position);
    if (!isPassableOpenDoor(upper) || upper!.getProperties().half !== "upper") continue;
    const lower = bot.blockAt(position.offset(0, -1, 0)), floor = bot.blockAt(position.offset(0, -2, 0));
    if (!isPassableOpenDoor(lower) || lower!.name !== upper!.name || lower!.getProperties().half !== "lower" ||
      lower!.getProperties().facing !== upper!.getProperties().facing || lower!.getProperties().hinge !== upper!.getProperties().hinge ||
      !floor || floor.shapes.length !== 1 || !floor.shapes[0]!.every((n, i) => n === (i < 3 ? 0 : 1))) continue;
    point.x = position.x + 0.5; point.y = position.y - 1; point.z = position.z + 0.5;
  }
}
