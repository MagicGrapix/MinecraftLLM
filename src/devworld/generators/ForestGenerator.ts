import type { Position } from "../../shared/types";
import type { PlannedCommand } from "../WorldPlan";
import { TreeGenerator, type PlannedTree } from "./TreeGenerator";

export interface ForestGeneratorOptions {
  readonly treeGenerator: TreeGenerator;
  readonly maxTrees: number;
  readonly maxRadius: number;
  readonly spacing: number;
  readonly maxAttemptsPerTree?: number;
}

export interface PlannedForest {
  readonly trees: readonly PlannedTree[];
  readonly commands: readonly PlannedCommand[];
}

export class ForestGenerator {
  private readonly maxAttemptsPerTree: number;

  constructor(private readonly options: ForestGeneratorOptions) {
    this.maxAttemptsPerTree = options.maxAttemptsPerTree ?? 100;
  }

  generate(
    center: Position,
    treeCount: number,
    radius: number,
  ): PlannedForest {
    if (
      !Number.isInteger(treeCount) ||
      treeCount <= 0 ||
      treeCount > this.options.maxTrees
    ) {
      throw new Error(
        `Forest tree count must be between 1 and ${this.options.maxTrees}.`,
      );
    }
    if (
      !Number.isInteger(radius) ||
      radius <= 0 ||
      radius > this.options.maxRadius
    ) {
      throw new Error(
        `Forest radius must be between 1 and ${this.options.maxRadius}.`,
      );
    }

    const trees: PlannedTree[] = [];
    for (let index = 0; index < treeCount; index += 1) {
      let accepted: PlannedTree | null = null;
      for (
        let attempt = 0;
        attempt < this.maxAttemptsPerTree;
        attempt += 1
      ) {
        const candidate = this.options.treeGenerator.generateNear(
          center,
          radius,
        );
        if (
          trees.every(
            (tree) =>
              horizontalDistance(tree.position, candidate.position) >=
              this.options.spacing,
          )
        ) {
          accepted = candidate;
          break;
        }
      }
      if (!accepted) {
        throw new Error(
          `Unable to place ${treeCount} spaced trees within radius ${radius}.`,
        );
      }
      trees.push(accepted);
    }

    return {
      trees,
      commands: trees.map((tree) => tree.command),
    };
  }
}

function horizontalDistance(left: Position, right: Position): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}
