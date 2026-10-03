import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Position } from "../../src/shared/types";
import type { BlockObservation } from "./types";

/** Read a small, explicit set of cells from server-fed chunks, without searching the world. */
export function observeBlocks(bot: Pick<Bot, "blockAt">, positions: readonly Position[]): BlockObservation[] {
  if (positions.length > 64) throw new Error("A scenario can observe at most 64 blocks.");
  return positions.map((position) => {
    if (![position.x, position.y, position.z].every(Number.isSafeInteger)) {
      throw new Error("Observed block positions must have integer coordinates.");
    }
    const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    return { position: { ...position }, name: block?.name ?? null };
  });
}
