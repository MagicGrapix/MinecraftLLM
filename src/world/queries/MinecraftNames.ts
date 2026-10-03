import { z } from "zod";
import type { WorldQueries } from "../WorldQueries";
import { queryFailure } from "./QueryResult";

export const MinecraftNamesSchema = z.array(z.string().trim().min(1)
  .regex(/^(minecraft:)?[a-z0-9_]+$/, 'Use one exact Minecraft ID per entry, e.g. "oak_log"; no comma-separated names, aliases or wildcards.'))
  .min(1).max(128)
  .describe('Array of exact Minecraft IDs, even for one name. Example: ["oak_log", "birch_log"]. Never "oak_log,birch_log" or "log" as a category. Optional minecraft: prefix is accepted.');

export function validateMinecraftNames(world: WorldQueries, kind: "block" | "item", names: readonly string[]) {
  const unknownNames = names.filter((name) => !world.isKnownName(kind, name));
  return unknownNames.length ? queryFailure("INVALID_ARGUMENT",
    `Unknown ${kind} name(s): ${unknownNames.map((name) => JSON.stringify(name)).join(", ")}. No search was performed. Use exact ${kind} IDs supported by this Minecraft version, e.g. ["oak_log"]. An empty result is only valid for a valid search.`,
    { kind, unknownNames }) : null;
}
