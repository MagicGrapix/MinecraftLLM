import type { Position } from "../../shared/types";
import {
  boundsVolume,
  containsBounds,
  createArenaBounds,
  type ArenaBounds,
} from "../ArenaBounds";
import { nextRandom, type RandomSource } from "../RandomSource";
import type { PlannedCommand } from "../WorldPlan";

export interface TreeGeneratorOptions {
  readonly arena: ArenaBounds;
  readonly surfaceY: number;
  readonly feature: string;
  readonly exclusionRadius: number;
  readonly footprintRadius: number;
  readonly maxHeight: number;
  readonly random: RandomSource;
  readonly maxAttempts?: number;
}

export interface PlannedTree {
  readonly position: Position;
  readonly command: PlannedCommand;
}

export class TreeGenerator {
  private readonly maxAttempts: number;

  constructor(private readonly options: TreeGeneratorOptions) {
    this.maxAttempts = options.maxAttempts ?? 200;
  }

  generateNear(center: Position, radius: number): PlannedTree {
    validateRadius(radius);
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const candidate = this.randomPosition(center, radius);
      if (
        horizontalDistance(candidate, center) <
        this.options.exclusionRadius
      ) {
        continue;
      }
      const planned = this.at(candidate);
      if (planned) return planned;
    }
    throw new Error(
      "Unable to place a tree within the configured arena and exclusion zone.",
    );
  }

  at(position: Position): PlannedTree | null {
    const origin = {
      x: Math.round(position.x),
      y: this.options.surfaceY + 1,
      z: Math.round(position.z),
    };
    const bounds = createArenaBounds(
      {
        x: origin.x - this.options.footprintRadius,
        y: origin.y,
        z: origin.z - this.options.footprintRadius,
      },
      {
        x: origin.x + this.options.footprintRadius,
        y: origin.y + this.options.maxHeight - 1,
        z: origin.z + this.options.footprintRadius,
      },
    );
    if (!containsBounds(this.options.arena, bounds)) return null;

    return {
      position: origin,
      command: {
        text: `place feature ${this.options.feature} ${origin.x} ${origin.y} ${origin.z}`,
        estimatedBlocksChanged: boundsVolume(bounds),
        affectedBounds: bounds,
      },
    };
  }

  private randomPosition(center: Position, radius: number): Position {
    const angle = nextRandom(this.options.random, 0, Math.PI * 2);
    const distance =
      Math.sqrt(nextRandom(this.options.random, 0, 1)) * radius;
    return {
      x: Math.round(center.x + Math.cos(angle) * distance),
      y: this.options.surfaceY + 1,
      z: Math.round(center.z + Math.sin(angle) * distance),
    };
  }
}

function validateRadius(radius: number): void {
  if (!Number.isInteger(radius) || radius <= 0) {
    throw new Error("Tree radius must be a positive integer.");
  }
}

function horizontalDistance(left: Position, right: Position): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}
