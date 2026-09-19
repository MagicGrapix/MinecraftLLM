import MinecraftData from "minecraft-data";

export const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION ?? "1.21.11";
export const DEFAULT_TASK_TIMEOUT_MS = 30_000;

export const mcData = MinecraftData(MINECRAFT_VERSION);
