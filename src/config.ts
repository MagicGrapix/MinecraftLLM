import MinecraftData from "minecraft-data";

export const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION ?? "1.21.11";
export const DEFAULT_TASK_TIMEOUT_MS = 30_000;
// Replay completed tools as readable text, or keep the original assistant/tool messages.
export const TOOL_REPLAY_MODE: "native" | "compact" = "compact";

export const mcData = MinecraftData(MINECRAFT_VERSION);
