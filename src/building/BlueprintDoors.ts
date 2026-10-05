import type { Position } from "../shared/types";
import { normalizeMinecraftName } from "../shared/helper";
import type { MaterialCatalog } from "../world/MaterialCatalog";
import type { Blueprint, BlueprintCell, BlueprintIssue, DoorFacing, DoorHinge, DoorPlacement, DoorProperties } from "./Blueprint";

export const SUPPORTED_DOORS: readonly string[] = ["oak_door"];
export const doorDirection: Record<DoorFacing, Position> = {
  north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 },
};
export const upperHalf = (p: Position): Position => ({ ...p, y: p.y + 1 });
export const doorProperties = (door: DoorPlacement, half: DoorProperties["half"]): DoorProperties => ({
  facing: door.facing, hinge: door.hinge, half, open: false, powered: false,
});

/** Java single-door rule with a click in the left half when neighbouring support is tied.
 * Adjacent doors are deliberately excluded; no implicit double-door pairing.
 */
export function expectedDoorHinge(position: Position, facing: DoorFacing, full: (p: Position) => boolean): DoorHinge {
  const direction = doorDirection[facing];
  const left = { x: direction.z, z: -direction.x };
  let balance = 0;
  for (const dy of [0, 1]) {
    if (full({ x: position.x + left.x, y: position.y + dy, z: position.z + left.z })) balance--;
    if (full({ x: position.x - left.x, y: position.y + dy, z: position.z - left.z })) balance++;
  }
  return balance > 0 ? "right" : "left";
}

/** Expand validated door dependencies without a generic dependency framework. */
export function compileDoors(blueprint: Blueprint, cells: BlueprintCell[], catalog: MaterialCatalog, issues: BlueprintIssue[]): DoorPlacement[] {
  const key = (p: Position) => `${p.x},${p.y},${p.z}`;
  const byPosition = new Map(cells.map((c, index) => [key(c.position), index]));
  const operations: DoorPlacement[] = [];
  for (const [index, door] of blueprint.dependencies.doors.entries()) {
    const path = `dependencies.doors.${index}`;
    const count = issues.length;
    door.item = normalizeMinecraftName(door.item);
    if (!SUPPORTED_DOORS.includes(door.item) || !catalog.resolve("block", door.item) || !catalog.resolve("item", door.item)) {
      issues.push({ code: "UNSUPPORTED_DEPENDENCY", path: `${path}.item`, received: door.item,
        message: "Only oak_door with a matching block and item in this Minecraft version is supported.",
        suggestions: catalog.search(door.item, "item").suggestions.map((s) => s.name) });
    }
    const positions = [door.position, upperHalf(door.position)];
    for (const position of positions) {
      if (position.x >= blueprint.width || position.z >= blueprint.depth || position.y >= blueprint.layers.length) {
        issues.push({ code: "DOOR_OUT_OF_BOUNDS", path, position, message: "Both door halves must fit inside the blueprint dimensions." });
      } else {
        const cell = cells[byPosition.get(key(position)) ?? -1];
        if (!cell || cell.kind !== "ignore") issues.push({ code: "DOOR_OVERLAP", path, position,
          message: "Each door half must occupy a distinct '_' cell, never a block, required air or another dependency." });
      }
    }
    const support = cells[byPosition.get(key({ ...door.position, y: door.position.y - 1 })) ?? -1];
    if (door.position.y > 0 && support?.kind !== "block") issues.push({ code: "DOOR_SUPPORT", path, position: door.position,
      message: "A door above layer zero needs a planned full block immediately below it." });
    for (const other of blueprint.dependencies.doors.slice(0, index)) {
      if (Math.abs(other.position.x - door.position.x) + Math.abs(other.position.z - door.position.z) === 1 &&
        Math.abs(other.position.y - door.position.y) <= 1) issues.push({ code: "ADJACENT_DOORS", path,
        message: "Adjacent/double doors are not supported in this version." });
    }
    if (issues.length !== count) continue;
    const operation: DoorPlacement = { kind: "place_door", position: { ...door.position }, block: door.item, item: door.item,
      facing: door.facing, hinge: expectedDoorHinge(door.position, door.facing, (p) => cells[byPosition.get(key(p)) ?? -1]?.kind === "block") };
    operations.push(operation);
    positions.forEach((position, half) => { cells[byPosition.get(key(position))!] = {
      kind: "door", position: { ...position }, block: door.item, properties: doorProperties(operation, half ? "upper" : "lower"),
    }; });
  }
  return operations;
}
