import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { PHOTO_ACTOR, xyz, type PreparedScene } from "./ScenePlan";

/** Controller observations are independent of command feedback (which can arrive late). */
export function sceneMismatch(scene: PreparedScene, controller: Bot, actor: Bot | null): string | null {
  for (const cell of scene.expected) {
    const observed = controller.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name;
    if (observed !== cell.block) return `Block ${xyz(cell.position)}: expected ${cell.block}, observed ${observed ?? "unloaded"}.`;
  }
  const entity = controller.players[PHOTO_ACTOR]?.entity;
  if (!actor || !entity) return "Photo actor is not visible to the controller.";
  const p = scene.actor.position;
  if (entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) > 0.15) return "Photo actor has not reached the requested pose position.";
  if (actor.heldItem?.name !== scene.scene.actor.hand || actor.heldItem.count !== 1) return "Photo actor's held item is not confirmed.";
  for (const expected of scene.drops) {
    const found = Object.values(controller.entities).some((drop) => {
      if (drop.name !== "item" || drop.position.distanceTo(new Vec3(expected.position.x, expected.position.y, expected.position.z)) > 0.3) return false;
      try { const item = drop.getDroppedItem(); return item?.name === expected.item && item.count === 1; }
      catch { return false; } // Entity metadata may follow its spawn packet.
    });
    if (!found) return `Loose ${expected.item} at ${xyz(expected.position)} is not confirmed.`;
  }
  return null;
}
