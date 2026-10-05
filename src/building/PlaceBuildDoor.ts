import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { ServerBlockObservation } from "../runtime/ServerBlockObservation";
import { toVec3 } from "../runtime/PositionAdapter";
import type { DoorPlacement } from "./Blueprint";
import { doorProperties, upperHalf } from "./BlueprintDoors";
import { canPlaceDoor, doorCursor, doorSupport, doorYaw } from "./BuildDoor";
import { BUILD_LIMITS } from "./BuildingConfig";
import type { BuildOperations } from "./BuildTypes";
import { matchesDoor } from "./BuildVerification";

/** Isolated Mineflayer adapter: its private placement helper is the only way to keep
 * yaw AND a non-centred click. Covered by smoke:doors on the pinned Java version.
 * Await physical settlement even if interrupted; the enclosing Executor owns the lock.
 */
export async function placeBuildDoor(bot: Bot, ops: BuildOperations, door: DoorPlacement, signal: AbortSignal): Promise<TaskResult> {
  const native = bot as Bot & { _placeBlockWithOptions?: (block: Block, face: Vec3,
    options: { delta: Vec3; forceLook: "ignore"; swingArm: "right" }) => Promise<void> };
  if (!native._placeBlockWithOptions) return failure("ACTION_NOT_CONFIRMED", "This Mineflayer version has no oriented placement helper.");
  signal.throwIfAborted();
  const cursor = doorCursor(door.facing), support = toVec3(doorSupport(door).referencePosition);
  const hit = support.plus(cursor), eyes = ops.eyes();
  if (!eyes) return failure("WORLD_CHANGED", "The bot must stand on the ground before placing a door.");
  // force=true resolves before the rotation packet is sent. Wait for actual rotation
  // or the server may orient the door using the previous movement's yaw.
  await bot.look(doorYaw[door.facing], Math.atan2(hit.y - eyes.y, Math.hypot(hit.x - eyes.x, hit.z - eyes.z)), false);
  signal.throwIfAborted();
  const currentEyes = ops.eyes(), reference = ops.blockAt(support);
  if (!reference || bot.heldItem?.name !== door.item || !currentEyes || !canPlaceDoor(ops, door, currentEyes, ops.position())) {
    return failure("WORLD_CHANGED", "Door support, clearance, inventory or hinge conditions changed before placement.", { facts: { position: door.position } });
  }
  const watchers = [door.position, upperHalf(door.position)].map(p => new ServerBlockObservation(bot, toVec3(p)));
  const predicates = ["lower", "upper"].map(half => (b: Block) => matchesDoor(b, {
    block: door.block, properties: { ...doorProperties(door, half as "lower" | "upper") },
  }));
  try {
    await native._placeBlockWithOptions(reference, new Vec3(0, 1, 0), { delta: cursor, forceLook: "ignore", swingArm: "right" });
    signal.throwIfAborted();
    // Both watchers are installed before sending: one half alone is never confirmation.
    await Promise.all(watchers.map((watcher, i) => watcher.wait(signal, BUILD_LIMITS.confirmationMs, predicates[i]!)));
    if (!watchers.every((watcher, i) => watcher.matches(predicates[i]!))) return failure("ACTION_NOT_CONFIRMED",
      "The server did not confirm both expected door halves. Observe before retrying; no automatic demolition.", {
        facts: { position: door.position, facing: door.facing, hinge: door.hinge,
          observed: [door.position, upperHalf(door.position)].map(p => ({ position: p, block: ops.blockAt(p)?.name, properties: ops.blockAt(p)?.getProperties() })) },
      });
    return success({ position: door.position, block: door.block, facing: door.facing, hinge: door.hinge, halvesConfirmed: 2 });
  } catch (error) {
    signal.throwIfAborted();
    return failure("ACTION_NOT_CONFIRMED", "Door placement was not confirmed; inspect both halves before retrying.", {
      facts: { position: door.position, cause: error instanceof Error ? error.message : String(error) },
    });
  } finally { watchers.forEach(watcher => watcher.dispose()); }
}
