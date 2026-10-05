import { Vec3 } from "vec3";
import type { Position } from "../shared/types";
import type { DoorFacing, DoorPlacement } from "./Blueprint";
import { expectedDoorHinge, upperHalf } from "./BlueprintDoors";
import { canPlaceFrom, overlapsBot, type PlacementCandidate } from "./BuildPlacement";
import { BUILD_LIMITS } from "./BuildingConfig";
import type { BuildOperations } from "./BuildTypes";
import { isAir, isFullCube } from "./BuildVerification";

export const doorYaw: Record<DoorFacing, number> = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 };
/** Top-face click chooses the left hinge on ties; side support can override it. */
export function doorCursor(facing: DoorFacing): Vec3 {
  return new Vec3(facing === "north" ? 0.25 : facing === "south" ? 0.75 : 0.5, 1,
    facing === "east" ? 0.25 : facing === "west" ? 0.75 : 0.5);
}
export function doorSupport(door: DoorPlacement) {
  return { referencePosition: { ...door.position, y: door.position.y - 1 }, face: "top" as const };
}
export function canPlaceDoor(ops: BuildOperations, door: DoorPlacement, eyes: Vec3, feet: Position): boolean {
  if (!isAir(ops.blockAt(upperHalf(door.position))) || overlapsBot(upperHalf(door.position), feet)) return false;
  // Unknown neighbours, adjoining doors and mismatched hinge support are not safe guesses.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [-1, 0, 1]) {
      const neighbour = ops.blockAt({ x: door.position.x + dx!, y: door.position.y + dy, z: door.position.z + dz! });
      if (!neighbour || neighbour.name.endsWith("_door")) return false;
    }
  }
  if (expectedDoorHinge(door.position, door.facing, p => isFullCube(ops.blockAt(p))) !== door.hinge) return false;
  return canPlaceFrom(ops, doorSupport(door), eyes, feet, doorCursor(door.facing));
}
export function doorCandidates(door: DoorPlacement, positions: readonly Position[], ops: BuildOperations, safeStance: (p: Position) => boolean): PlacementCandidate[] {
  const eyes = ops.eyes();
  if (!eyes) return [];
  const height = eyes.y - ops.position().y, seen = new Set<string>(), candidates: PlacementCandidate[] = [];
  for (const feet of [ops.position(), ...positions.map(p => new Vec3(p.x + 0.5, p.y, p.z + 0.5))]) {
    const key = feet.floored().toString();
    if (seen.has(key) || !safeStance(feet)) continue;
    if (canPlaceDoor(ops, door, feet.offset(0, height, 0), feet)) {
      candidates.push({ ...doorSupport(door), feet }); seen.add(key);
    }
    if (candidates.length >= BUILD_LIMITS.maxCandidates) break;
  }
  return candidates;
}
