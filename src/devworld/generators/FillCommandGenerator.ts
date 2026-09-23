import {
  boundsVolume,
  createArenaBounds,
  type ArenaBounds,
} from "../ArenaBounds";
import type { PlannedCommand } from "../WorldPlan";

export class FillCommandGenerator {
  constructor(readonly maxBlocksPerCommand: number) {
    if (
      !Number.isInteger(maxBlocksPerCommand) ||
      maxBlocksPerCommand <= 0
    ) {
      throw new Error("maxBlocksPerCommand must be a positive integer.");
    }
  }

  generate(
    bounds: ArenaBounds,
    block: string,
  ): readonly PlannedCommand[] {
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(block)) {
      throw new Error(`Invalid namespaced block id "${block}".`);
    }
    return this.split(bounds).map((part) => ({
      text: `fill ${formatPosition(part.min)} ${formatPosition(
        part.max,
      )} ${block} replace`,
      estimatedBlocksChanged: boundsVolume(part),
      affectedBounds: part,
    }));
  }

  private split(bounds: ArenaBounds): ArenaBounds[] {
    if (boundsVolume(bounds) <= this.maxBlocksPerCommand) {
      return [bounds];
    }

    const axis = longestAxis(bounds);
    const midpoint = Math.floor(
      (bounds.min[axis] + bounds.max[axis]) / 2,
    );
    if (midpoint < bounds.min[axis] || midpoint >= bounds.max[axis]) {
      throw new Error(
        "Unable to split fill bounds below the configured block limit.",
      );
    }

    const leftMax = { ...bounds.max, [axis]: midpoint };
    const rightMin = { ...bounds.min, [axis]: midpoint + 1 };
    return [
      ...this.split(createArenaBounds(bounds.min, leftMax)),
      ...this.split(createArenaBounds(rightMin, bounds.max)),
    ];
  }
}

function longestAxis(bounds: ArenaBounds): "x" | "y" | "z" {
  const lengths = {
    x: bounds.max.x - bounds.min.x + 1,
    y: bounds.max.y - bounds.min.y + 1,
    z: bounds.max.z - bounds.min.z + 1,
  };
  return (["x", "y", "z"] as const).reduce((longest, axis) =>
    lengths[axis] > lengths[longest] ? axis : longest,
  );
}

function formatPosition(position: {
  x: number;
  y: number;
  z: number;
}): string {
  return `${position.x} ${position.y} ${position.z}`;
}
