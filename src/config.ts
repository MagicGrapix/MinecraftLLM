import MinecraftData from "minecraft-data";

export const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION ?? "1.21.11";
export const DEFAULT_TASK_TIMEOUT_MS = 30_000;
export const ACTION_CONFIRMATION = { pollIntervalMs: 100, timeoutMs: 3_000 };
export const STATION_LIMITS = {
  searchRadius: 8,
  interactionReach: 4.5,
  maxSmeltQuantity: 16,
  smeltItemMs: 10_000,
  smeltMarginMs: 20_000,
  furnaceTimeoutMs: 210_000,
};
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
export const PLANNER_MAX_TOOL_CALLS = 16;
export const PLAN_LIMITS = {
  recipesPerStep: 4,
  uniqueRecipes: 16,
  checkLines: 8,
  checkChars: 2_000,
};
export const RECIPE_LIMITS = {
  maxVariants: 8,
  maxFileBytes: 32_768,
  searchResults: 5,
  maxResultChars: 6_000,
};
// Approximate INPUT budget, including system prompt and tool schemas (not a tokenizer).
export const CONTEXT_BUDGET = {
  charsPerToken: 3,
  compactAtTokens: 20_000,
  targetTokens: 10_000,
  summaryMaxChars: 3_000,
};

export const mcData = MinecraftData(MINECRAFT_VERSION);
