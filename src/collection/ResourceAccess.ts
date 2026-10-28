import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { Block } from "prismarine-block";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { toVec3 } from "../runtime/PositionAdapter";
import type { CollectionSource } from "./CollectionTypes";
import type { Resource } from "./ResourceCatalog";

export function canHarvestResource(block: Block, tool: Item | null, resource: Resource): boolean {
  if (!block.canHarvest(tool?.type ?? null)) return false;
  // Silk Touch changes stone/grass/ore drops, even when it is a perfectly good mining tool.
  return block.name === resource.item || !tool?.enchants.some(e => e.name === "silk_touch");
}

export function inspectHarvest(bot: Bot, source: CollectionSource, resource: Resource): TaskResult<{ block: Block; tool: Item | null }> {
  const block = bot.blockAt(toVec3(source.position));
  if (!block || block.name !== source.name || block.stateId !== source.stateId || !resource.sources.includes(block.name)) {
    return failure("WORLD_CHANGED", "The resource cell changed or is not loaded.");
  }
  if (!block.diggable || block.boundingBox === "empty") return failure("BLOCKED", "The source is not a solid diggable block.");
  const feet = bot.entity.position;
  if (feet.x + 0.3 > source.position.x && feet.x - 0.3 < source.position.x + 1 &&
      feet.z + 0.3 > source.position.z && feet.z - 0.3 < source.position.z + 1 && source.position.y < feet.y && source.position.y + 1 >= feet.y - 0.01) {
    return failure("BLOCKED", "Collection will not dig the block supporting the bot.");
  }
  // Do not open a hole straight into the void/liquid/unknown terrain in the thin test world.
  const below = bot.blockAt(block.position.offset(0, -1, 0));
  if (source.position.y <= Math.floor(feet.y) && (!below || below.boundingBox !== "block" || below.shapes.length !== 1 ||
      !below.shapes[0]!.every((n, i) => n === (i < 3 ? 0 : 1)))) {
    return failure("BLOCKED", "This collector requires a known full support below the source.");
  }
  const tools: (Item | null)[] = [bot.heldItem, null, ...bot.inventory.items()];
  const usable = tools.filter(tool => canHarvestResource(block, tool, resource) &&
    (!tool || !bot.registry.items[tool.type]?.maxDurability || tool.durabilityUsed < bot.registry.items[tool.type]!.maxDurability!));
  usable.sort((a, b) => block.digTime(a?.type ?? null, false, false, false, a?.enchants) - block.digTime(b?.type ?? null, false, false, false, b?.enchants));
  if (!usable.length) return failure("MISSING_ITEM", `No inventory tool can harvest ${resource.item} from ${block.name} without changing its drop.`);
  return success({ block, tool: usable[0]! });
}
