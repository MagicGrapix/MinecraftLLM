import { mcData } from "../config";
import type { Task } from "../execution/Task";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { Position } from "../shared/types";
import type { WorldQueries } from "../world/WorldQueries";
import type {
  BlockInfo,
  EntityInfo,
  FindBlocksOptions,
  InventoryItemInfo,
  InventoryState,
  NearbyEntitiesOptions,
  SelfState,
} from "../world/types";
import type { LabScenario } from "./LabScenario";

interface Drop {
  id: number;
  name: string;
  count: number;
  position: Position;
}

const faceOffsets = {
  top: { x: 0, y: 1, z: 0 },
  bottom: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
} as const;

export class LabWorld implements WorldQueries {
  private readonly self: SelfState;
  private readonly inventory: Map<string, number>;
  private readonly blocks = new Map<string, string>();
  private readonly drops: Drop[] = [];
  private selectedItem: string | null;
  private nextDropId = 1;

  constructor(private readonly scenario: LabScenario) {
    this.self = structuredClone(scenario.self);
    this.inventory = new Map(Object.entries(scenario.inventory));
    this.selectedItem = scenario.selectedItem;
    for (const block of scenario.blocks) {
      this.blocks.set(key(block.position), block.name);
    }
  }

  snapshot(): {
    self: SelfState;
    inventory: InventoryState;
    blocks: readonly { position: Position; name: string }[];
    drops: readonly Drop[];
  } {
    return {
      self: this.getSelf(),
      inventory: this.getInventory(),
      blocks: [...this.blocks.entries()].map(([coordinate, name]) => ({
        position: fromKey(coordinate),
        name,
      })),
      drops: structuredClone(this.drops),
    };
  }

  getSelf(): SelfState {
    return structuredClone(this.self);
  }

  getInventory(): InventoryState {
    const items = [...this.inventory.entries()]
      .filter(([, count]) => count > 0)
      .map(([name, count], index) => itemInfo(name, count, 36 + index));
    return {
      items,
      selectedItem: items.find((item) => item.name === this.selectedItem) ?? null,
    };
  }

  getBlock(position: Position): BlockInfo | null {
    const name = this.blocks.get(key(position)) ?? this.baseBlock(position.y);
    const data = mcData.blocksByName[name];
    return {
      name,
      displayName: data?.displayName ?? name,
      type: data?.id ?? 0,
      position: { ...position },
      boundingBox: data?.boundingBox ?? (name === "air" ? "empty" : "block"),
    };
  }

  findNearestBlocks(names: string | readonly string[], options: FindBlocksOptions = {}): BlockInfo[] {
    const wanted = new Set((typeof names === "string" ? [names] : names).map(normalizeName));
    const maxDistance = options.maxDistance ?? 32;
    const count = options.count ?? 1;
    const candidates = new Map<string, BlockInfo>();
    for (const coordinate of this.blocks.keys()) {
      const position = fromKey(coordinate);
      if (distance(position, this.self.position) > maxDistance) continue;
      const block = this.getBlock(position)!;
      if (wanted.has(block.name)) candidates.set(coordinate, block);
    }
    if (["grass_block", "dirt", "bedrock"].some((name) => wanted.has(name))) {
      const radius = Math.min(Math.ceil(maxDistance), 8);
      const centerX = Math.floor(this.self.position.x);
      const centerZ = Math.floor(this.self.position.z);
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          for (const y of [this.scenario.surfaceY, this.scenario.surfaceY - 1, this.scenario.surfaceY - 3]) {
            const position = { x: centerX + dx, y, z: centerZ + dz };
            if (distance(position, this.self.position) > maxDistance) continue;
            const block = this.getBlock(position)!;
            if (wanted.has(block.name)) candidates.set(key(position), block);
          }
        }
      }
    }
    return [...candidates.values()]
      .sort((a, b) => distance(a.position, this.self.position) - distance(b.position, this.self.position))
      .slice(0, count);
  }

  getNearbyEntities(options: NearbyEntitiesOptions = {}): EntityInfo[] {
    return this.drops.map((drop) => ({
      id: drop.id,
      name: "item",
      type: "other",
      username: null,
      position: { ...drop.position },
      distance: distance(drop.position, this.self.position),
      droppedItem: {
        name: drop.name,
        displayName: mcData.itemsByName[drop.name]?.displayName ?? drop.name,
        count: drop.count,
      },
    })).filter((entity) =>
      entity.distance <= (options.maxDistance ?? 32) &&
      (options.type === undefined || options.type === "item" || options.type === entity.type))
      .sort((a, b) => a.distance - b.distance);
  }

  applySuccess(task: Task): TaskResult {
    const input = task.input as Record<string, unknown>;
    switch (task.capability) {
      case "goto": {
        const position = input.position as Position;
        this.self.position = { ...position };
        for (let index = this.drops.length - 1; index >= 0; index -= 1) {
          const drop = this.drops[index]!;
          if (distance(drop.position, position) <= 1.5) {
            this.changeInventory(drop.name, drop.count);
            this.drops.splice(index, 1);
          }
        }
        return success({ position: { ...position }, distanceToTarget: 0 });
      }
      case "dig": {
        const position = input.position as Position;
        const block = this.getBlock(position)!;
        if (block.boundingBox === "empty" || block.name === "bedrock") {
          return failure("TARGET_NOT_FOUND", `No diggable block at ${key(position)}.`, { facts: { position } });
        }
        this.blocks.set(key(position), "air");
        if (this.scenario.autoCollectDrops) {
          this.changeInventory(block.name, 1);
        } else {
          this.drops.push({
            id: this.nextDropId++,
            name: block.name,
            count: 1,
            position: { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 },
          });
        }
        return success({
          position: { ...position }, block: block.name,
          tool: this.selectedItem ?? "hand", estimatedDurationMs: 0,
          waitedForGroundMs: 0, durationMs: 0,
        });
      }
      case "equip": {
        const name = normalizeName(String(input.item));
        const item = this.getInventory().items.find((candidate) => candidate.name === name);
        if (!item) return failure("MISSING_ITEM", `Item ${name} is not in inventory.`, { facts: { item: name } });
        this.selectedItem = name;
        return success({ item: name, slot: item.slot, destination: input.destination ?? "hand" });
      }
      case "place": {
        const reference = input.referencePosition as Position;
        const face = input.face as keyof typeof faceOffsets;
        const offset = faceOffsets[face];
        const referenceBlock = this.getBlock(reference)!;
        if (referenceBlock.boundingBox === "empty") {
          return failure("TARGET_NOT_FOUND", "The placement reference is empty.", { facts: { referencePosition: reference } });
        }
        const target = { x: reference.x + offset.x, y: reference.y + offset.y, z: reference.z + offset.z };
        if (this.getBlock(target)?.boundingBox !== "empty") {
          return failure("BLOCKED", "The placement target is occupied.", { facts: { position: target } });
        }
        const item = this.selectedItem;
        if (!item || !this.inventory.get(item) || !mcData.blocksByName[item]) {
          return failure("MISSING_ITEM", "No placeable block is equipped.");
        }
        this.blocks.set(key(target), item);
        this.changeInventory(item, -1);
        return success({ item, position: target });
      }
      default:
        return failure("INVALID_ARGUMENT", `The lab cannot simulate ${task.capability}.`);
    }
  }

  private changeInventory(name: string, delta: number): void {
    const next = (this.inventory.get(name) ?? 0) + delta;
    if (next <= 0) {
      this.inventory.delete(name);
      if (this.selectedItem === name) this.selectedItem = null;
    } else {
      this.inventory.set(name, next);
      if (!this.selectedItem) this.selectedItem = name;
    }
  }

  private baseBlock(y: number): string {
    if (y === this.scenario.surfaceY) return "grass_block";
    if (y > this.scenario.surfaceY - 3 && y < this.scenario.surfaceY) return "dirt";
    if (y === this.scenario.surfaceY - 3) return "bedrock";
    return "air";
  }
}

function itemInfo(name: string, count: number, slot: number): InventoryItemInfo {
  const item = mcData.itemsByName[name];
  return {
    name,
    displayName: item?.displayName ?? name,
    type: item?.id ?? 0,
    metadata: 0,
    count,
    slot,
  };
}

function normalizeName(name: string): string {
  return name.replace(/^minecraft:/, "");
}

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`;
}

function fromKey(value: string): Position {
  const [x, y, z] = value.split(",").map(Number);
  return { x: x!, y: y!, z: z! };
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
