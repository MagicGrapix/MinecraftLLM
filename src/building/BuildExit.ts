import type { Position } from "../shared/types";
import type { CompiledBlueprint } from "./Blueprint";
import type { BuildOperations } from "./BuildTypes";
import { BUILD_LIMITS } from "./BuildingConfig";
import { isAir, isFullCube } from "./BuildVerification";

const key = (p: Position) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y && a.z === b.z;

/** Conservative voxel route back to the exterior AFTER the proposed placement.
 * Cardinal walking, one-block jumps, at most three-block drops; no digging/parkour/scaffolds.
 * This screens work stances, not a replacement for Mineflayer's real pathfinding.
 */
export function safeExitStances(plan: CompiledBlueprint, origin: Position, ops: BuildOperations, placed: Position, door = false): (feet: Position) => boolean {
  const occupied = (p: Position) => same(p, placed) || (door && same(p, { ...placed, y: placed.y + 1 }));
  const air = (p: Position) => !occupied(p) && isAir(ops.blockAt(p));
  // A door blocks passage but is not a full-block platform to stand on.
  const solid = (p: Position) => occupied(p) ? !door : isFullCube(ops.blockAt(p));
  const outside = (p: Position) => p.x < origin.x || p.x >= origin.x + plan.blueprint.width || p.z < origin.z || p.z >= origin.z + plan.blueprint.depth;
  const stands = new Map<string, Position>();
  const reachable = new Set<string>();
  const queue: Position[] = [];
  const margin = BUILD_LIMITS.workMargin;
  for (let y = origin.y; y <= origin.y + plan.height; y++) {
    for (let x = origin.x - margin; x < origin.x + plan.blueprint.width + margin; x++) {
      for (let z = origin.z - margin; z < origin.z + plan.blueprint.depth + margin; z++) {
        const p = { x, y, z };
        if (solid({ x, y: y - 1, z }) && air(p) && air({ x, y: y + 1, z })) {
          stands.set(key(p), p);
          if (outside(p) && y === origin.y) { reachable.add(key(p)); queue.push(p); }
        }
      }
    }
  }
  // Reverse traversal: which work positions can get to a known exterior position?
  for (let i = 0; i < queue.length; i++) {
    const to = queue[i]!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (let dy = -1; dy <= 3; dy++) {
        const from = stands.get(key({ x: to.x + dx, y: to.y + dy, z: to.z + dz }));
        if (!from || reachable.has(key(from))) continue;
        if (to.y > from.y && !air({ x: from.x, y: from.y + 2, z: from.z })) continue;
        let clear = true;
        for (let y = to.y; y <= Math.max(to.y + 1, from.y + 1); y++) {
          if (!air({ x: to.x, y, z: to.z })) { clear = false; break; }
        }
        if (clear) { reachable.add(key(from)); queue.push(from); }
      }
    }
  }
  return (feet) => reachable.has(key(feet));
}
