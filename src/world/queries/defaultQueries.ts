import { z } from "zod";
import { BlockPositionSchema } from "../../shared/types";
import type { WorldQueries } from "../WorldQueries";
import type { BlockAccessInfo } from "../BlockAccess";
import type {
  BlockInfo,
  EntityInfo,
  InventoryState,
  SelfState,
} from "../types";
import { buildVoxelView, type VoxelView } from "../VoxelView";
import { queryFailure, querySuccess } from "./QueryResult";
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
  description: "Return the bot's current position, cardinal facing, and survival state.",
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

const getBlockAccessQuery: WorldQuery<
  z.infer<typeof getBlockInputSchema>,
  BlockAccessInfo
> = {
  name: "get_block_access",
  description: "Read a block's loaded state, eye-to-center distance, dig reach, unobstructed dig face, canDig preflight, reason and an observed blocker. Visible is independent of camera direction; null means unknown (including unloaded cells or visibility beyond 64 blocks). Reach is eye-to-face, not center distance. This never moves or digs and does not prove server permission or item pickup.",
  inputSchema: getBlockInputSchema,
  execute: async (input, world) =>
    querySuccess(world.getBlockAccess(input.position)),
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
  description: "List nearby entities, including the item stack carried by visible dropped-item entities when known; optionally filter by type.",
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

const getVoxelViewQuery: WorldQuery<
  z.infer<typeof voxelViewInputSchema>,
  VoxelView
> = {
  name: "get_voxel_view",
  description: "Read a 5x5x4 north-up block grid around the bot or an observed integer position. Offsets are dx west/east, dy down/up, dz north/south; optional focus resolves one cell to world coordinates.",
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
  getNearbyEntitiesQuery,
  getVoxelViewQuery,
] as const;

export function createDefaultWorldQueryRegistry(
  world: WorldQueries,
): WorldQueryRegistry {
  const registry = new WorldQueryRegistry(world);
  registry.register(getSelfQuery);
  registry.register(getInventoryQuery);
  registry.register(getBlockQuery);
  registry.register(getBlockAccessQuery);
  registry.register(findNearestBlocksQuery);
  registry.register(getNearbyEntitiesQuery);
  registry.register(getVoxelViewQuery);
  return registry;
}
