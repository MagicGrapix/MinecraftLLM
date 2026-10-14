import type { Bot } from "mineflayer";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { normalizeMinecraftName } from "../shared/helper";

export interface Resource { item: string; sources: readonly string[] }
export const RESOURCE_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  oak_log: ["oak_log"], spruce_log: ["spruce_log"], birch_log: ["birch_log"],
  jungle_log: ["jungle_log"], acacia_log: ["acacia_log"], dark_oak_log: ["dark_oak_log"],
  mangrove_log: ["mangrove_log"], cherry_log: ["cherry_log"], pale_oak_log: ["pale_oak_log"],
  dirt: ["dirt", "grass_block"], cobblestone: ["stone", "cobblestone"],
});

export function resolveResource(name: string, registry: Bot["registry"]): TaskResult<Resource> {
  const item = normalizeMinecraftName(name);
  if (!Object.hasOwn(registry.itemsByName, item)) return failure("INVALID_ARGUMENT", `Unknown Minecraft item "${item}".`);
  if (!Object.hasOwn(RESOURCE_SOURCES, item)) return failure("INVALID_ARGUMENT", `Resource "${item}" is not supported by collect_resource.`, {
    facts: { supported: Object.keys(RESOURCE_SOURCES) },
  });
  const sources = RESOURCE_SOURCES[item]!.filter(block => Object.hasOwn(registry.blocksByName, block));
  if (!sources.length) return failure("INVALID_ARGUMENT", `No source blocks for "${item}" exist in this Minecraft version.`);
  return success({ item, sources });
}
