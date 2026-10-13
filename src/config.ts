import MinecraftData from "minecraft-data";

export const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION ?? "1.21.11";
export const DEFAULT_TASK_TIMEOUT_MS = 30_000;
export const ACTION_CONFIRMATION = { pollIntervalMs: 100, timeoutMs: 3_000 };
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
// Approximate INPUT budget, including system prompt and tool schemas (not a tokenizer).
export const CONTEXT_BUDGET = {
  charsPerToken: 3,
  compactAtTokens: 20_000,
  targetTokens: 10_000,
  summaryMaxChars: 3_000,
};

export const mcData = MinecraftData(MINECRAFT_VERSION);
