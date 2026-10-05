import { iterators } from "prismarine-world";
import { Vec3 } from "vec3";
import type { PlaceInput } from "../capabilities/Place";
import type { Position, BlockFace } from "../shared/types";
import type { CompiledBlueprint } from "./Blueprint";
import { BLUEPRINT_SOLID_BLOCKS, BUILD_LIMITS } from "./BuildingConfig";
import type { BuildOperations } from "./BuildTypes";
import { isAir, isFullCube } from "./BuildVerification";

const normals: Record<BlockFace, Vec3> = {
  top: new Vec3(0, 1, 0), north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0), bottom: new Vec3(0, -1, 0),
};
// Do not right-click an interactive support (chest, crafting table...) by accident.
const safeSupports = new Set<string>([...BLUEPRINT_SOLID_BLOCKS, "grass_block", "bedrock"]);
export interface PlacementCandidate extends PlaceInput { feet: Position }
const vec = (p: Position): Vec3 => new Vec3(p.x, p.y, p.z);

export function overlapsBot(target: Position, feet: Position): boolean {
  return feet.x + 0.3 > target.x && feet.x - 0.3 < target.x + 1 &&
    feet.z + 0.3 > target.z && feet.z - 0.3 < target.z + 1 &&
    feet.y + 1.8 > target.y && feet.y < target.y + 1;
}

/** Same face centers as Mineflayer placeBlock; no look/move side effects. */
export function canPlaceFrom(ops: BuildOperations, input: PlaceInput, eyes: Vec3, feet: Position, cursor?: Vec3): boolean {
  const normal = normals[input.face];
  const support = vec(input.referencePosition);
  const target = support.plus(normal);
  const block = ops.blockAt(support);
  if (!block || !safeSupports.has(block.name) || !isFullCube(block) || !isAir(ops.blockAt(target)) || overlapsBot(target, feet)) return false;
  const face = cursor ? support.plus(cursor) : support.offset(0.5, 0.5, 0.5).plus(normal.scaled(0.5));
  const offset = eyes.minus(face);
  const distance = eyes.distanceTo(face);
  if (offset.dot(normal) <= 0.001 || distance > BUILD_LIMITS.placementReach) return false;
  const ray = new iterators.RaycastIterator(eyes, face.minus(eyes).normalize(), distance + 0.01);
  let cell: Position | null = eyes.floored();
  while (cell) {
    const observed = ops.blockAt(cell);
    if (!observed) return false;
    const hit = ray.intersect(observed.shapes, observed.position);
    if (hit) return observed.position.equals(support) && Math.abs(eyes.distanceTo(hit.pos) - distance) < 0.01;
    cell = ray.next();
  }
  return false;
}

export function workPositions(plan: CompiledBlueprint, origin: Position, ops: BuildOperations): Position[] {
  const margin = BUILD_LIMITS.workMargin;
  const positions: Position[] = [];
  for (let y = origin.y; y <= origin.y + plan.height; y++) {
    for (let x = origin.x - margin; x < origin.x + plan.blueprint.width + margin; x++) {
      for (let z = origin.z - margin; z < origin.z + plan.blueprint.depth + margin; z++) {
        const feet = { x, y, z };
        if (isFullCube(ops.blockAt({ x, y: y - 1, z })) && isAir(ops.blockAt(feet)) && isAir(ops.blockAt({ x, y: y + 1, z }))) positions.push(feet);
      }
    }
  }
  return positions.sort((a, b) => vec(a).offset(0.5, 0, 0.5).distanceTo(ops.position()) - vec(b).offset(0.5, 0, 0.5).distanceTo(ops.position()));
}

export function placementCandidates(target: Position, positions: readonly Position[], ops: BuildOperations, safeStance: (p: Position) => boolean): PlacementCandidate[] {
  const eyes = ops.eyes();
  if (!eyes) return [];
  const height = eyes.y - ops.position().y;
  const candidates: PlacementCandidate[] = [];
  const seen = new Set<string>();
  // Try the current actual position first, then deterministic standing-cell centers.
  for (const feet of [ops.position(), ...positions.map((p) => vec(p).offset(0.5, 0, 0.5))]) {
    const key = vec(feet).floored().toString();
    if (seen.has(key)) continue;
    if (!safeStance(feet)) continue;
    for (const [face, normal] of Object.entries(normals) as [BlockFace, Vec3][]) {
      const referencePosition = vec(target).minus(normal);
      const input = { referencePosition, face };
      if (canPlaceFrom(ops, input, vec(feet).offset(0, height, 0), feet)) {
        candidates.push({ ...input, feet }); seen.add(key); break;
      }
    }
    if (candidates.length >= BUILD_LIMITS.maxCandidates) break;
  }
  // One face per stance is enough. Do not spend the retry budget on the same cell.
  return candidates;
}
