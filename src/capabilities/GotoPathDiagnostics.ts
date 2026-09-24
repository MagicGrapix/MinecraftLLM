import type { Bot } from "mineflayer";
import type { PartiallyComputedPath } from "mineflayer-pathfinder";
import type { Position } from "../shared/types";
import { toVec3 } from "../runtime/PositionAdapter";
import type { WorldQueries } from "../world/WorldQueries";

interface SearchUpdate {
  readonly status: PartiallyComputedPath["status"];
  readonly timeMs: number;
  readonly visitedNodes: number;
  readonly generatedNodes: number;
  readonly pathLength: number;
  readonly bestSearchPosition: Position | null;
}

export class GotoPathDiagnostics {
  private updateCount = 0;
  private lastUpdate: SearchUpdate | null = null;
  private lastResetReason: string | null = null;
  private readonly startPosition: Position;

  constructor(
    private readonly bot: Bot,
    private readonly world: WorldQueries,
    private readonly target: Position,
    private readonly range: number,
  ) {
    this.startPosition = positionOf(bot.entity.position);
    bot.on("path_update", this.onPathUpdate);
    bot.on("path_reset", this.onPathReset);
  }

  detach(): void {
    this.bot.removeListener("path_update", this.onPathUpdate);
    this.bot.removeListener("path_reset", this.onPathReset);
  }

  failureFacts(reason: string): Record<string, unknown> {
    const blockTarget = {
      x: Math.floor(this.target.x),
      y: Math.floor(this.target.y),
      z: Math.floor(this.target.z),
    };
    const approaches = [
      { direction: "north", x: 0, z: -1 },
      { direction: "east", x: 1, z: 0 },
      { direction: "south", x: 0, z: 1 },
      { direction: "west", x: -1, z: 0 },
    ].map(({ direction, x, z }) => {
      const position = {
        x: blockTarget.x + x,
        y: blockTarget.y,
        z: blockTarget.z + z,
      };
      return {
        direction,
        support: this.blockName({ ...position, y: position.y - 1 }),
        feet: this.blockName(position),
        head: this.blockName({ ...position, y: position.y + 1 }),
      };
    });

    return {
      startPosition: this.startPosition,
      finalPosition: positionOf(this.bot.entity.position),
      target: this.target,
      range: this.range,
      reason,
      thinkTimeoutMs: this.bot.pathfinder.thinkTimeout,
      pathUpdateCount: this.updateCount,
      lastSearch: this.lastUpdate,
      lastResetReason: this.lastResetReason,
      targetChunkLoaded: this.chunkLoaded(blockTarget),
      targetBlock: this.blockName(blockTarget),
      approaches,
    };
  }

  private readonly onPathUpdate = (update: PartiallyComputedPath): void => {
    this.updateCount += 1;
    const best = update.path.at(-1);
    this.lastUpdate = {
      status: update.status,
      timeMs: update.time,
      visitedNodes: update.visitedNodes,
      generatedNodes: update.generatedNodes,
      pathLength: update.path.length,
      bestSearchPosition: best ? positionOf(best) : null,
    };
  };

  private readonly onPathReset = (reason: string): void => {
    this.lastResetReason = reason;
  };

  private blockName(position: Position): string | null {
    try {
      return this.world.getBlock(position)?.name ?? null;
    } catch {
      return null;
    }
  }

  private chunkLoaded(position: Position): boolean | null {
    try {
      return this.bot.world.getColumnAt(toVec3(position)) != null;
    } catch {
      return null;
    }
  }
}

function positionOf(position: Position): Position {
  return { x: position.x, y: position.y, z: position.z };
}
