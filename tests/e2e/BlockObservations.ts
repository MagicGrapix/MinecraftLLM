import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Position } from "../../src/shared/types";
import type { BlockObservation } from "./types";

/** Covers the entire maximum blueprint plus its working margin and protected ground. */
export const MAX_OBSERVED_BLOCKS = 4096;
const STATE_PROPERTIES = ["facing", "half", "hinge", "open", "powered"] as const;

/** Bounded explicit cells from server-fed chunks, never a sampled or truncated volume. */
export function observeBlocks(bot: Pick<Bot, "blockAt">, positions: readonly Position[]): BlockObservation[] {
  if (positions.length > MAX_OBSERVED_BLOCKS) throw new Error(`A scenario can observe at most ${MAX_OBSERVED_BLOCKS} blocks.`);
  // Validate the whole request before any world access.
  for (const position of positions) {
    if (![position.x, position.y, position.z].every(Number.isSafeInteger)) {
      throw new Error("Observed block positions must have integer coordinates.");
    }
  }
  return positions.map((position) => {
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    const raw = block?.getProperties?.() ?? {};
    const properties: Record<string, string | number | boolean> = {};
    for (const key of STATE_PROPERTIES) {
      const value = raw[key];
      if (["string", "number", "boolean"].includes(typeof value)) properties[key] = value!;
    }
    return { position: { ...position }, name: block?.name ?? null, properties: block ? properties : null };
  });
}
