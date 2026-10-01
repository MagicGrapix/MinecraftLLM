import type { Bot } from "mineflayer";
import type { PartiallyComputedPath } from "mineflayer-pathfinder";
import type { Block } from "prismarine-block";
import type { Position } from "../shared/types";

export interface ObservedBlockChange {
  position: Position;
  before: string;
  after: string;
}

// Record net changes observed at cells the pathfinder intends to dig/place.
// These are client-world observations, not proof of pickup or server acceptance.
export class GotoTerrainTracker {
  private readonly planned = new Set<string>();
  private readonly changes = new Map<string, ObservedBlockChange>();

  constructor(private readonly bot: Bot) {
    bot.on("path_update", this.onPathUpdate);
    bot.on("blockUpdate", this.onBlockUpdate);
  }

  snapshot(): ObservedBlockChange[] {
    return [...this.changes.values()].filter((change) => change.before !== change.after)
      .map((change) => ({ ...change, position: { ...change.position } }));
  }

  detach(): void {
    this.bot.removeListener("path_update", this.onPathUpdate);
    this.bot.removeListener("blockUpdate", this.onBlockUpdate);
  }

  private readonly onPathUpdate = (update: PartiallyComputedPath): void => {
    for (const move of update.path) {
      for (const position of move.toBreak ?? []) this.planned.add(key(position));
      for (const raw of move.toPlace ?? []) {
        // Pathfinder's declarations omit the placement face offsets.
        const placement = raw as Position & { dx?: number; dy?: number; dz?: number; useOne?: boolean };
        if (placement.useOne || placement.dx === undefined || placement.dy === undefined || placement.dz === undefined) continue;
        this.planned.add(key({ x: placement.x + placement.dx, y: placement.y + placement.dy, z: placement.z + placement.dz }));
      }
    }
  };

  private readonly onBlockUpdate = (before: Block | null, after: Block | null): void => {
    if (!before || !after) return;
    const cell = key(after.position);
    if (!this.planned.has(cell)) return;
    const previous = this.changes.get(cell);
    this.changes.set(cell, {
      position: { x: after.position.x, y: after.position.y, z: after.position.z },
      before: previous?.before ?? before.name,
      after: after.name,
    });
  };
}

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`;
}
