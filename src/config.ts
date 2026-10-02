import MinecraftData from "minecraft-data";

export const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION ?? "1.21.11";
export const DEFAULT_TASK_TIMEOUT_MS = 30_000;
// goto may alter terrain; scaffolding is taken only from the bot's inventory.
export const GOTO_DEFAULTS = {
  canDig: true,
  canPlace: true,
  scaffoldingItems: ["dirt", "cobblestone"] as readonly string[],
  digCost: 3,
  placeCost: 3,
};
// Replay completed tools as readable text, or keep the original assistant/tool messages.
export const TOOL_REPLAY_MODE: "native" | "compact" = "compact";
// Total validated tool invocations per delegation; parsing retries do not count.
export const ACTION_MAX_TOOL_CALLS = 256;

export const mcData = MinecraftData(MINECRAFT_VERSION);
