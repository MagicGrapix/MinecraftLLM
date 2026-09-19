import { z } from "zod";
import { BlockPositionSchema } from "../../shared/types";
import type { WorldQueries } from "../WorldQueries";
import type {
  BlockInfo,
  EntityInfo,
  InventoryState,
  SelfState,
} from "../types";
import { querySuccess } from "./QueryResult";
import type { WorldQuery } from "./WorldQuery";
import { WorldQueryRegistry } from "./WorldQueryRegistry";

const emptyInputSchema = z.object({}).strict();
const getBlockInputSchema = z
  .object({ position: BlockPositionSchema })
  .strict();
const findNearestBlocksInputSchema = z
  .object({
    names: z.union([
      z.string().trim().min(1),
      z.array(z.string().trim().min(1)).min(1),
    ]),
    maxDistance: z.number().finite().positive().max(512).optional(),
    count: z.number().int().positive().max(128).optional(),
  })
  .strict();
const nearbyEntitiesInputSchema = z
  .object({
    maxDistance: z.number().finite().positive().max(512).optional(),
    type: z.string().trim().min(1).optional(),
  })
  .strict();

const getSelfQuery: WorldQuery<
  z.infer<typeof emptyInputSchema>,
  SelfState
> = {
  name: "get_self",
  description: "Return the bot's current position and survival state.",
  inputSchema: emptyInputSchema,
  execute: async (_input, world) => querySuccess(world.getSelf()),
};

const getInventoryQuery: WorldQuery<
  z.infer<typeof emptyInputSchema>,
  InventoryState
> = {
  name: "get_inventory",
  description: "Return a compact snapshot of the bot's inventory.",
  inputSchema: emptyInputSchema,
  execute: async (_input, world) => querySuccess(world.getInventory()),
};

const getBlockQuery: WorldQuery<
  z.infer<typeof getBlockInputSchema>,
  BlockInfo | null
> = {
  name: "get_block",
  description: "Inspect the block at an exact integer position.",
  inputSchema: getBlockInputSchema,
  execute: async (input, world) =>
    querySuccess(world.getBlock(input.position)),
};

const findNearestBlocksQuery: WorldQuery<
  z.infer<typeof findNearestBlocksInputSchema>,
  BlockInfo[]
> = {
  name: "find_nearest_blocks",
  description: "Find nearby blocks matching one or more Minecraft names.",
  inputSchema: findNearestBlocksInputSchema,
  execute: async (input, world) =>
    querySuccess(
      world.findNearestBlocks(input.names, {
        ...(input.maxDistance === undefined
          ? {}
          : { maxDistance: input.maxDistance }),
        ...(input.count === undefined ? {} : { count: input.count }),
      }),
    ),
};

const getNearbyEntitiesQuery: WorldQuery<
  z.infer<typeof nearbyEntitiesInputSchema>,
  EntityInfo[]
> = {
  name: "get_nearby_entities",
  description: "List nearby entities, optionally filtered by type.",
  inputSchema: nearbyEntitiesInputSchema,
  execute: async (input, world) =>
    querySuccess(
      world.getNearbyEntities({
        ...(input.maxDistance === undefined
          ? {}
          : { maxDistance: input.maxDistance }),
        ...(input.type === undefined ? {} : { type: input.type }),
      }),
    ),
};

export const defaultWorldQueries = [
  getSelfQuery,
  getInventoryQuery,
  getBlockQuery,
  findNearestBlocksQuery,
  getNearbyEntitiesQuery,
] as const;

export function createDefaultWorldQueryRegistry(
  world: WorldQueries,
): WorldQueryRegistry {
  const registry = new WorldQueryRegistry(world);
  registry.register(getSelfQuery);
  registry.register(getInventoryQuery);
  registry.register(getBlockQuery);
  registry.register(findNearestBlocksQuery);
  registry.register(getNearbyEntitiesQuery);
  return registry;
}
