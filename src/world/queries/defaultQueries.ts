import { z } from "zod";
import { BlockPositionSchema } from "../../shared/types";
import type { WorldQueries } from "../WorldQueries";
import type { BlockAccessInfo } from "../BlockAccess";
import type {
  BlockInfo,
  InventoryState,
  SelfState,
} from "../types";
import { buildVoxelView, type VoxelView } from "../VoxelView";
import { queryFailure, querySuccess } from "./QueryResult";
import type { WorldQuery } from "./WorldQuery";
import { WorldQueryRegistry } from "./WorldQueryRegistry";
import { getDroppedItemsQuery } from "./GetDroppedItems";
import type { ToolCallJournal } from "../../execution/ToolCallJournal";
import { inventoryDiffQuery } from "./GetInventoryDiff";
import { MinecraftNamesSchema, validateMinecraftNames } from "./MinecraftNames";

const emptyInputSchema = z.object({}).strict();
const getBlockInputSchema = z
  .object({ position: BlockPositionSchema })
  .strict();
const findNearestBlocksInputSchema = z
  .object({
    names: MinecraftNamesSchema,
    maxDistance: z.number().finite().positive().max(512).optional().describe("Search radius in blocks from the bot. Default 32; maximum 512."),
    count: z.number().int().positive().max(128).optional().describe("Maximum matching block positions to return, not a harvest quantity. Default 1; maximum 128."),
  })
  .strict();
const voxelViewInputSchema = z
  .object({
    center: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("self") }).strict(),
      z.object({
        kind: z.literal("position"),
        position: BlockPositionSchema,
      }).strict(),
    ]),
    focus: z.object({
      dx: z.number().int().min(-2).max(2),
      dy: z.number().int().min(-1).max(2),
      dz: z.number().int().min(-2).max(2),
    }).strict().optional(),
  })
  .strict();
const maxVoxelViewCenterDistance = 64;

const getSelfQuery: WorldQuery<
  z.infer<typeof emptyInputSchema>,
  SelfState
> = {
  name: "get_self",
  description: "Return the bot's current position, cardinal facing, and survival state (life + hunger).",
  inputSchema: emptyInputSchema,
  execute: async (_input, world) => querySuccess(world.getSelf()),
};

const getInventoryQuery: WorldQuery<
  z.infer<typeof emptyInputSchema>,
  InventoryState
> = {
  name: "get_inventory",
  description: "Does: Inspect the bot's inventory and selected item.\nReturns: Current item quantities.\nLimits: Does not show when or how items were acquired.\nNotes: get_inventory_diff_after compares the saved before/after inventories of a numbered capability or run_step.",
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

const getBlockAccessQuery: WorldQuery<
  z.infer<typeof getBlockInputSchema>,
  BlockAccessInfo
> = {
  name: "get_block_access",
  description: "Does: Check local digging conditions for one block.\nReturns: Reach, unobstructed face, canDig, and any observed blocker.\nLimits: Does not prove server permission or successful digging.\nNotes: null means unknown. Visibility ignores camera direction. Center distance is not the face-reach test.",
  inputSchema: getBlockInputSchema,
  execute: async (input, world) =>
    querySuccess(world.getBlockAccess(input.position)),
};

const findNearestBlocksQuery: WorldQuery<
  z.infer<typeof findNearestBlocksInputSchema>,
  BlockInfo[]
> = {
  name: "find_nearest_blocks",
  description: "Does: Find placed blocks matching the requested names.\nReturns: Matching blocks known within the search radius.\nLimits: Does not check visibility, reachability, or dig access.\nNotes: count limits results. No results does not mean none exist elsewhere.",
  inputSchema: findNearestBlocksInputSchema,
  execute: async (input, world) => {
    const invalid = validateMinecraftNames(world, "block", input.names);
    if (invalid) return invalid;
    return querySuccess(
      world.findNearestBlocks(input.names, {
        ...(input.maxDistance === undefined
          ? {}
          : { maxDistance: input.maxDistance }),
        ...(input.count === undefined ? {} : { count: input.count }),
      }),
    );
  },
};

const getVoxelViewQuery: WorldQuery<
  z.infer<typeof voxelViewInputSchema>,
  VoxelView
> = {
  name: "get_voxel_view",
  description: "Does: Show a 5x5x4 block grid around the bot or a position.\nReturns: Terrain layers and a symbol legend; focus resolves a cell to world coordinates.\nLimits: Does not show loot or prove a usable path.\nNotes: North is up, regardless of facing. Unknown cells are not air.",
  inputSchema: voxelViewInputSchema,
  execute: async (input, world) => {
    const self = world.getSelf();
    if (input.center.kind === "position") {
      const { x, y, z } = input.center.position;
      const dx = x - self.position.x;
      const dy = y - self.position.y;
      const dz = z - self.position.z;
      if (dx * dx + dy * dy + dz * dz > maxVoxelViewCenterDistance ** 2) {
        return queryFailure(
          "INVALID_ARGUMENT",
          `Voxel view center must be within ${maxVoxelViewCenterDistance} blocks of the bot.`,
          { position: input.center.position },
        );
      }
    }
    return querySuccess(buildVoxelView(world, input, self));
  },
};

export const defaultWorldQueries = [
  getSelfQuery,
  getInventoryQuery,
  getBlockQuery,
  getBlockAccessQuery,
  findNearestBlocksQuery,
  getDroppedItemsQuery,
  getVoxelViewQuery,
] as const;

export function createDefaultWorldQueryRegistry(
  world: WorldQueries,
  journal?: ToolCallJournal,
): WorldQueryRegistry {
  const registry = new WorldQueryRegistry(world);
  registry.register(getSelfQuery);
  registry.register(getInventoryQuery);
  registry.register(getBlockQuery);
  registry.register(getBlockAccessQuery);
  registry.register(findNearestBlocksQuery);
  registry.register(getDroppedItemsQuery);
  registry.register(getVoxelViewQuery);
  if (journal) registry.register(inventoryDiffQuery(journal));
  return registry;
}
