import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { fromVec3, toVec3 } from "../runtime/PositionAdapter";
import { normalizeMinecraftName } from "../shared/helper";
import type { Position } from "../shared/types";
import type { WorldQueries } from "./WorldQueries";
import type {
  BlockInfo,
  EntityInfo,
  FindBlocksOptions,
  InventoryItemInfo,
  InventoryState,
  NearbyEntitiesOptions,
  SelfState,
} from "./types";

export class MineflayerWorldQueries implements WorldQueries {
  constructor(private readonly runtime: MinecraftRuntime) {}

  getSelf(): SelfState {
    const bot = this.runtime.bot;

    return {
      position: fromVec3(bot.entity.position),
      health: bot.health,
      food: bot.food,
      foodSaturation: bot.foodSaturation,
      oxygenLevel: bot.oxygenLevel,
      onGround: bot.entity.onGround,
    };
  }

  getInventory(): InventoryState {
    const bot = this.runtime.bot;

    return {
      items: bot.inventory.items().map(toInventoryItemInfo),
      selectedItem: bot.heldItem ? toInventoryItemInfo(bot.heldItem) : null,
    };
  }

  getBlock(position: Position): BlockInfo | null {
    const block = this.runtime.bot.blockAt(toVec3(position));
    return block ? toBlockInfo(block) : null;
  }

  findNearestBlocks(
    names: string | readonly string[],
    options: FindBlocksOptions = {},
  ): BlockInfo[] {
    const bot = this.runtime.bot;
    const requestedNames = typeof names === "string" ? [names] : names;
    const blockIds = requestedNames
      .map((name) => bot.registry.blocksByName[normalizeMinecraftName(name)]?.id)
      .filter((id): id is number => id !== undefined);

    if (blockIds.length === 0) return [];

    return bot
      .findBlocks({
        matching: blockIds,
        maxDistance: options.maxDistance ?? 32,
        count: options.count ?? 1,
      })
      .map((position) => bot.blockAt(position))
      .filter((block): block is Block => block !== null)
      .map(toBlockInfo)
      .sort(
        (left, right) =>
          distanceSquared(left.position, bot.entity.position) -
          distanceSquared(right.position, bot.entity.position),
      );
  }

  getNearbyEntities(options: NearbyEntitiesOptions = {}): EntityInfo[] {
    const bot = this.runtime.bot;
    const maxDistance = options.maxDistance ?? 32;

    return Object.values(bot.entities)
      .filter((entity) => entity.id !== bot.entity.id)
      .map<EntityInfo>((entity) => ({
        id: entity.id,
        name: entity.name ?? null,
        type: entity.type,
        username: entity.username ?? null,
        position: fromVec3(entity.position),
        distance: entity.position.distanceTo(bot.entity.position),
      }))
      .filter(
        (entity) =>
          entity.distance <= maxDistance &&
          (options.type === undefined ||
            entity.type === options.type ||
            entity.name === options.type),
      )
      .sort((left, right) => left.distance - right.distance);
  }
}

function toInventoryItemInfo(item: Item): InventoryItemInfo {
  return {
    name: item.name,
    displayName: item.displayName,
    type: item.type,
    metadata: item.metadata,
    count: item.count,
    slot: item.slot,
  };
}

function toBlockInfo(block: Block): BlockInfo {
  return {
    name: block.name,
    displayName: block.displayName,
    type: block.type,
    position: fromVec3(block.position),
    boundingBox: block.boundingBox,
  };
}

function distanceSquared(
  left: Position,
  right: { x: number; y: number; z: number },
): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}
