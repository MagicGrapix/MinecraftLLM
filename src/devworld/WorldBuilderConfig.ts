import { z } from "zod";
import { MINECRAFT_VERSION } from "../config";
import { createArenaBounds, type ArenaBounds } from "./ArenaBounds";

const usernameSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9_]+$/);
const namespacedIdSchema = z
  .string()
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/);

const EnvironmentSchema = z.object({
  MINECRAFT_HOST: z.string().trim().min(1).default("localhost"),
  MINECRAFT_PORT: integerEnvironment(25_565, 1, 65_535),
  MINECRAFT_VERSION: z.string().trim().min(1).default(MINECRAFT_VERSION),
  MINECRAFT_USERNAME: usernameSchema.default("bot"),
  WORLD_CONTROLLER_USERNAME: usernameSchema.default("world_controller"),
  WORLD_AGENT_USERNAME: usernameSchema.optional(),
  // Vanilla counts player-issued commands toward its chat-spam budget.
  WORLD_COMMANDS_PER_SECOND: numericEnvironment(1, 0.1, 1),
  WORLD_COMMAND_RESPONSE_WINDOW_MS: integerEnvironment(150, 0, 10_000),
  WORLD_MAX_QUEUE_SIZE: integerEnvironment(1_000, 1),
  WORLD_MAX_PLAN_COMMANDS: integerEnvironment(256, 1),
  WORLD_MAX_FILL_BLOCKS: integerEnvironment(32_768, 1, 32_768),
  WORLD_ARENA_MIN_X: integerEnvironment(-48),
  WORLD_ARENA_MAX_X: integerEnvironment(48),
  WORLD_ARENA_MIN_Y: integerEnvironment(-64, -64, 319),
  WORLD_ARENA_MAX_Y: integerEnvironment(-30, -64, 319),
  WORLD_ARENA_MIN_Z: integerEnvironment(-48),
  WORLD_ARENA_MAX_Z: integerEnvironment(48),
  WORLD_SURFACE_Y: integerEnvironment(-61),
  WORLD_MAX_TREES: integerEnvironment(32, 1, 256),
  WORLD_MAX_FOREST_RADIUS: integerEnvironment(40, 1, 1_024),
  WORLD_MAX_VEIN_SIZE: integerEnvironment(64, 1, 1_024),
  WORLD_TREE_FEATURE: namespacedIdSchema.default("minecraft:oak"),
});

export interface WorldBuilderConfig {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly controllerUsername: string;
  readonly agentUsername: string;
  readonly commandsPerSecond: number;
  readonly commandResponseWindowMs: number;
  readonly maxQueueSize: number;
  readonly maxPlanCommands: number;
  readonly maxFillBlocks: number;
  readonly arena: ArenaBounds;
  readonly surfaceY: number;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  readonly maxTrees: number;
  readonly maxForestRadius: number;
  readonly maxVeinSize: number;
  readonly treeFeature: string;
  readonly treeDefaultRadius: number;
  readonly treeExclusionRadius: number;
  readonly treeSpacing: number;
  readonly treeFootprintRadius: number;
  readonly treeMaxHeight: number;
  readonly controllerParkY: number;
}

export function loadWorldBuilderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorldBuilderConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const arena = createArenaBounds(
    {
      x: parsed.WORLD_ARENA_MIN_X,
      y: parsed.WORLD_ARENA_MIN_Y,
      z: parsed.WORLD_ARENA_MIN_Z,
    },
    {
      x: parsed.WORLD_ARENA_MAX_X,
      y: parsed.WORLD_ARENA_MAX_Y,
      z: parsed.WORLD_ARENA_MAX_Z,
    },
  );
  const surfaceY = parsed.WORLD_SURFACE_Y;
  if (
    surfaceY - 3 < arena.min.y ||
    surfaceY + 1 > arena.max.y
  ) {
    throw new Error(
      "WORLD_SURFACE_Y must leave room for bedrock, dirt, grass, and player spawn inside the arena.",
    );
  }
  if (
    !(
      arena.min.x <= 0 &&
      arena.max.x >= 0 &&
      arena.min.z <= 0 &&
      arena.max.z >= 0
    )
  ) {
    throw new Error("The configured arena must contain spawn X=0 Z=0.");
  }
  if (parsed.WORLD_MAX_PLAN_COMMANDS > parsed.WORLD_MAX_QUEUE_SIZE) {
    throw new Error(
      "WORLD_MAX_PLAN_COMMANDS cannot exceed WORLD_MAX_QUEUE_SIZE.",
    );
  }

  return {
    host: parsed.MINECRAFT_HOST,
    port: parsed.MINECRAFT_PORT,
    version: parsed.MINECRAFT_VERSION,
    controllerUsername: parsed.WORLD_CONTROLLER_USERNAME,
    agentUsername:
      parsed.WORLD_AGENT_USERNAME ?? parsed.MINECRAFT_USERNAME,
    commandsPerSecond: parsed.WORLD_COMMANDS_PER_SECOND,
    commandResponseWindowMs:
      parsed.WORLD_COMMAND_RESPONSE_WINDOW_MS,
    maxQueueSize: parsed.WORLD_MAX_QUEUE_SIZE,
    maxPlanCommands: parsed.WORLD_MAX_PLAN_COMMANDS,
    maxFillBlocks: parsed.WORLD_MAX_FILL_BLOCKS,
    arena,
    surfaceY,
    spawn: { x: 0, y: surfaceY + 1, z: 0 },
    maxTrees: parsed.WORLD_MAX_TREES,
    maxForestRadius: parsed.WORLD_MAX_FOREST_RADIUS,
    maxVeinSize: parsed.WORLD_MAX_VEIN_SIZE,
    treeFeature: parsed.WORLD_TREE_FEATURE,
    treeDefaultRadius: 10,
    treeExclusionRadius: 4,
    treeSpacing: 5,
    treeFootprintRadius: 4,
    treeMaxHeight: 12,
    controllerParkY: arena.max.y + 128,
  };
}

function numericEnvironment(
  defaultValue: number,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) =>
      value === undefined || value === "" ? defaultValue : Number(value),
    z.number().finite().min(minimum).max(maximum),
  );
}

function integerEnvironment(
  defaultValue: number,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) =>
      value === undefined || value === "" ? defaultValue : Number(value),
    z.number().int().min(minimum).max(maximum),
  );
}
