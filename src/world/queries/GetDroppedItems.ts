import { z } from "zod";
import type { DroppedItemInfo, EntityInfo } from "../types";
import { querySuccess } from "./QueryResult";
import type { WorldQuery } from "./WorldQuery";
import { MinecraftNamesSchema, validateMinecraftNames } from "./MinecraftNames";
import { normalizeMinecraftName } from "../../shared/helper";

const inputSchema = z.object({
  names: MinecraftNamesSchema.optional().describe('Optional array of exact item IDs, e.g. ["oak_log"]. No comma-separated string or category aliases. Omit to also see unidentified drops.'),
  maxDistance: z.number().finite().positive().max(512).optional()
    .describe("Maximum distance from the bot in blocks (default 32, maximum 512)."),
  count: z.number().int().positive().max(128).optional()
    .describe("Maximum number of returned item entities, nearest first (default 16, maximum 128). Not an item quantity to collect."),
}).strict();

/** Read-only projection of the existing entity API; no pickup or movement. */
export const getDroppedItemsQuery: WorldQuery<z.infer<typeof inputSchema>, DroppedItemInfo[]> = {
  name: "get_dropped_items",
  description: "Does: Find nearby loose item entities.\nReturns: Observed positions and stack quantities.\nLimits: Does not prove reachability or pickup.\nNotes: count limits entities, not item quantity. Name filters exclude unidentified drops.",
  inputSchema,
  execute: async (input, world) => {
    if (input.names) {
      const invalid = validateMinecraftNames(world, "item", input.names);
      if (invalid) return invalid;
    }
    const maxDistance = input.maxDistance ?? 32;
    const names = input.names === undefined ? null
      : new Set(input.names.map(normalizeMinecraftName));
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
