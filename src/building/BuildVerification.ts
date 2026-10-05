import type { Block } from "prismarine-block";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { Position } from "../shared/types";
import type { CompiledBlueprint, BlueprintPlacement } from "./Blueprint";
import { BUILD_LIMITS } from "./BuildingConfig";
import type { BuildOperations } from "./BuildTypes";
import { doorProperties, upperHalf } from "./BlueprintDoors";

export const isAir = (block: Block | null): boolean => !!block && ["air", "cave_air", "void_air"].includes(block.name);
export const isFullCube = (block: Block | null): boolean => !!block && block.shapes.length === 1 &&
  block.shapes[0]!.every((n, i) => n === (i < 3 ? 0 : 1));
export const worldPosition = (origin: Position, local: Position): Position => ({
  x: origin.x + local.x, y: origin.y + local.y, z: origin.z + local.z,
});
export function matchesDoor(block: Block | null, expected: { block: string; properties: Readonly<Record<string, unknown>> }): boolean {
  if (!block || block.name !== expected.block) return false;
  const properties = block.getProperties();
  return Object.entries(expected.properties).every(([name, value]) => properties[name] === value);
}

export interface BuildInspection { correct: number; pending: BlueprintPlacement[] }

/** Unknown cells are errors, never air. No demolition or implicit replacement. */
export function inspectBuild(plan: CompiledBlueprint, origin: Position, ops: BuildOperations): TaskResult<BuildInspection> {
  let correct = 0;
  const pending: BlueprintPlacement[] = [];
  for (const cell of plan.cells) {
    if (cell.kind === "ignore" || cell.kind === "door") continue;
    const position = worldPosition(origin, cell.position);
    const actual = ops.blockAt(position);
    if (!actual) return failure("WORLD_CHANGED", "A required blueprint cell is not loaded.", { facts: { reason: "UNLOADED_CELL", position } });
    if (cell.kind === "block" && actual.name === cell.block) { correct++; continue; }
    if (!isAir(actual)) return failure("BLOCKED", "The blueprint conflicts with an existing block; build will not remove it.", {
      facts: { reason: "SITE_CONFLICT", position, expected: cell.kind === "block" ? cell.block : "air", observed: actual.name },
    });
    if (cell.kind === "block") pending.push({ kind: "place_block", position, block: cell.block, item: cell.block });
  }
  for (const local of plan.operations) {
    if (local.kind !== "place_door") continue;
    const door = { ...local, position: worldPosition(origin, local.position) };
    const lower = ops.blockAt(door.position), upper = ops.blockAt(upperHalf(door.position));
    if (!lower || !upper) return failure("WORLD_CHANGED", "A door half is not loaded.", { facts: { reason: "UNLOADED_CELL", position: door.position } });
    if (isAir(lower) && isAir(upper)) { pending.push(door); continue; }
    if (matchesDoor(lower, { block: door.block, properties: { ...doorProperties(door, "lower") } }) &&
        matchesDoor(upper, { block: door.block, properties: { ...doorProperties(door, "upper") } }) &&
        isFullCube(ops.blockAt({ ...door.position, y: door.position.y - 1 }))) { correct++; continue; }
    return failure("BLOCKED", "The existing door is partial, differently oriented, open, powered, or unsupported; no automatic replacement is performed.", {
      facts: { reason: "DOOR_CONFLICT", position: door.position, expected: { facing: door.facing, hinge: door.hinge, open: false, powered: false },
        lower: { block: lower.name, properties: lower.getProperties() }, upper: { block: upper.name, properties: upper.getProperties() } },
    });
  }
  return success({ correct, pending });
}

export function checkBuildSite(plan: CompiledBlueprint, origin: Position, ops: BuildOperations): TaskResult {
  const { width, depth } = plan.blueprint;
  const margin = BUILD_LIMITS.workMargin;
  const start = ops.position();
  if (!Number.isInteger(ops.minY) || !Number.isInteger(ops.maxY) || ops.maxY < ops.minY) {
    return failure("WORLD_CHANGED", "World height bounds are not available.", { facts: { reason: "UNKNOWN_WORLD_BOUNDS" } });
  }
  // Include headroom at the highest work stance and the supporting ground.
  for (const x of [origin.x - margin, origin.x + width - 1 + margin]) {
    for (const z of [origin.z - margin, origin.z + depth - 1 + margin]) {
      for (const y of [origin.y - 1, origin.y + plan.height + 1]) {
        if (y < ops.minY || y > ops.maxY || Math.abs(x) >= 29_999_984 || Math.abs(z) >= 29_999_984 ||
          Math.hypot(x - start.x, y - start.y, z - start.z) > BUILD_LIMITS.maxRadius) {
          return failure("INVALID_ARGUMENT", "The entire build site and work margin must fit within world bounds and 50 blocks of the bot.", { facts: { reason: "SITE_OUT_OF_BOUNDS" } });
        }
      }
    }
  }
  for (let x = origin.x - margin; x < origin.x + width + margin; x++) {
    for (let z = origin.z - margin; z < origin.z + depth + margin; z++) {
      const position = { x, y: origin.y - 1, z };
      if (!isFullCube(ops.blockAt(position))) return failure("BLOCKED", "This builder requires loaded, flat, full-block ground under the footprint and its two-block work margin.", {
        facts: { reason: "UNSUPPORTED_GROUND", position },
      });
    }
  }
  return success({});
}

export function checkBuildMaterials(pending: readonly BlueprintPlacement[], ops: BuildOperations): TaskResult {
  const required = new Map<string, number>();
  for (const op of pending) required.set(op.item, (required.get(op.item) ?? 0) + 1);
  const inventory = ops.inventory();
  const missing = [...required].flatMap(([item, quantity]) => {
    const available = inventory.get(item) ?? 0;
    return available < quantity ? [{ item, required: quantity, available, missing: quantity - available }] : [];
  });
  return missing.length ? failure("MISSING_ITEM", "Not enough materials for the remaining construction; no resources are acquired automatically.", {
    facts: { reason: "MISSING_BUILD_MATERIALS", missing },
  }) : success({});
}
