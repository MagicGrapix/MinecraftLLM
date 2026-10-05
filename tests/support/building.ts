import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { PlaceInput } from "../../src/capabilities/Place";
import { success, type TaskResult } from "../../src/execution/TaskResult";
import type { Position } from "../../src/shared/types";
import type { BuildOperations } from "../../src/building/BuildTypes";
import type { DoorPlacement } from "../../src/building/Blueprint";
import { doorProperties, upperHalf } from "../../src/building/BlueprintDoors";

export function testBlock(name: string, p: Position, properties = {}): Block {
  return { name, position: new Vec3(p.x, p.y, p.z), stateId: name === "air" ? 0 : 1,
    boundingBox: name === "air" ? "empty" : "block", shapes: name === "air" ? [] : name.endsWith("_door") ? [[0, 0, 0, 1, 1, 0.1875]] : [[0, 0, 0, 1, 1, 1]],
    getProperties: () => properties,
  } as unknown as Block;
}

/** Geometry is real; movement and server acceptance are explicit test doubles. */
export class TestBuildOperations implements BuildOperations {
  minY = -64; maxY = 319; dimension = "overworld";
  feet = new Vec3(-1.5, 0, -1.5);
  cells = new Map<string, string | null>();
  properties = new Map<string, Record<string, unknown>>();
  stock = new Map<string, number>([["oak_planks", 55], ["cobblestone", 25]]);
  moves: Position[] = [];
  placements: Position[] = [];
  onMove?: () => Promise<TaskResult>;
  onPlace?: () => Promise<TaskResult>;
  key(p: Position) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; }
  set(p: Position, name: string | null) { this.cells.set(this.key(p), name); }
  blockAt(p: Position): Block | null {
    const name = this.cells.has(this.key(p)) ? this.cells.get(this.key(p))! : p.y < 0 ? "grass_block" : "air";
    return name === null ? null : testBlock(name, p, this.properties.get(this.key(p)));
  }
  position() { return this.feet.clone(); }
  eyes() { return this.feet.offset(0, 1.62, 0); }
  inventory() { return this.stock; }
  async move(position: Position): Promise<TaskResult> {
    this.moves.push(position);
    if (this.onMove) { const result = await this.onMove(); if (!result.ok) return result; }
    this.feet = new Vec3(position.x + 0.5, position.y, position.z + 0.5);
    return success({});
  }
  async place(input: PlaceInput, block: string): Promise<TaskResult> {
    if (this.onPlace) { const result = await this.onPlace(); if (!result.ok) return result; }
    const offsets: Record<PlaceInput["face"], number[]> = { top: [0,1,0], bottom: [0,-1,0], north: [0,0,-1], south: [0,0,1], east: [1,0,0], west: [-1,0,0] };
    const d = offsets[input.face];
    const p = { x: input.referencePosition.x + d[0]!, y: input.referencePosition.y + d[1]!, z: input.referencePosition.z + d[2]! };
    this.set(p, block); this.placements.push(p); this.stock.set(block, (this.stock.get(block) ?? 0) - 1);
    return success({});
  }
  async placeDoor(door: DoorPlacement): Promise<TaskResult> {
    if (this.onPlace) { const result = await this.onPlace(); if (!result.ok) return result; }
    for (const [i, p] of [door.position, upperHalf(door.position)].entries()) {
      this.set(p, door.block); this.properties.set(this.key(p), { ...doorProperties(door, i ? "upper" : "lower") });
    }
    this.placements.push(door.position); this.stock.set(door.item, (this.stock.get(door.item) ?? 0) - 1);
    return success({});
  }
}
