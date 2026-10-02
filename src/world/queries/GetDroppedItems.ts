import { z } from "zod";
import type { DroppedItemInfo, EntityInfo } from "../types";
import { querySuccess } from "./QueryResult";
import type { WorldQuery } from "./WorldQuery";

const inputSchema = z.object({
  names: z.union([
    z.string().trim().min(1),
    z.array(z.string().trim().min(1)).min(1),
  ]).optional().describe("Optional exact item name(s), such as oak_log. Filters known stacks only; omit to also see unidentified drops."),
  maxDistance: z.number().finite().positive().max(512).optional()
    .describe("Maximum distance from the bot in blocks (default 32, maximum 512)."),
  count: z.number().int().positive().max(128).optional()
    .describe("Maximum number of returned item entities, nearest first (default 16, maximum 128). Not an item quantity to collect."),
}).strict();

/** Read-only projection of the existing entity API; no pickup or movement. */
export const getDroppedItemsQuery: WorldQuery<z.infer<typeof inputSchema>, DroppedItemInfo[]> = {
  name: "get_dropped_items",
  description: "Find nearby loose/dropped item entities known to the bot, not placed blocks, mobs or players. Returns id, item name, count, position and distance, nearest first. Optional names filters known item stacks; without it, unidentified drops have null item/count. This only observes, does not guarantee reachability or collect anything: move to the drop and verify pickup with get_inventory.",
  inputSchema,
  execute: async (input, world) => {
    const maxDistance = input.maxDistance ?? 32;
    const names = input.names === undefined ? null
      : new Set(typeof input.names === "string" ? [input.names] : input.names);
    const drops = world.getNearbyEntities({ maxDistance })
      .filter(isDroppedItemEntity)
      .filter((entity) => entity.distance <= maxDistance &&
        (names === null || (entity.droppedItem !== null && names.has(entity.droppedItem.name))))
      .sort((left, right) => left.distance - right.distance || left.id - right.id)
      .slice(0, input.count ?? 16)
      .map((entity): DroppedItemInfo => ({
        id: entity.id,
        item: entity.droppedItem?.name ?? null,
        count: entity.droppedItem?.count ?? null,
        position: { ...entity.position },
        distance: entity.distance,
      }));
    return querySuccess(drops);
  },
};

function isDroppedItemEntity(entity: EntityInfo): boolean {
  return entity.name === "item" || entity.name === "Item" ||
    entity.name === "item_stack" || entity.type === "item";
}
