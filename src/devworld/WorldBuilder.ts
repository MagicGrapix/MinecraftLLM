import type { Position } from "../shared/types";
import type { WorldBuilderConfig } from "./WorldBuilderConfig";
import {
  SystemRandomSource,
  type RandomSource,
} from "./RandomSource";
import {
  WorldPlanFactory,
  type IdSource,
  type WorldPlan,
} from "./WorldPlan";
import type { OreKind } from "./BlockCatalog";
import { FillCommandGenerator } from "./generators/FillCommandGenerator";
import { ForestGenerator } from "./generators/ForestGenerator";
import { OreVeinGenerator } from "./generators/OreVeinGenerator";
import { ResetArenaGenerator } from "./generators/ResetArenaGenerator";
import { TreeGenerator } from "./generators/TreeGenerator";

export interface WorldBuilderOptions {
  readonly config: WorldBuilderConfig;
  readonly random?: RandomSource;
  readonly createId?: IdSource;
}

export class WorldBuilder {
  private readonly plans: WorldPlanFactory;
  private readonly resetGenerator: ResetArenaGenerator;
  private readonly treeGenerator: TreeGenerator;
  private readonly forestGenerator: ForestGenerator;
  private readonly oreGenerator: OreVeinGenerator;

  constructor(private readonly options: WorldBuilderOptions) {
    const random = options.random ?? new SystemRandomSource();
    const fill = new FillCommandGenerator(options.config.maxFillBlocks);
    this.plans = new WorldPlanFactory({
      arena: options.config.arena,
      maxPlanCommands: options.config.maxPlanCommands,
      createId: options.createId,
    });
    this.resetGenerator = new ResetArenaGenerator({
      arena: options.config.arena,
      surfaceY: options.config.surfaceY,
      agentUsername: options.config.agentUsername,
      fill,
    });
    this.treeGenerator = new TreeGenerator({
      arena: options.config.arena,
      surfaceY: options.config.surfaceY,
      feature: options.config.treeFeature,
      exclusionRadius: options.config.treeExclusionRadius,
      footprintRadius: options.config.treeFootprintRadius,
      maxHeight: options.config.treeMaxHeight,
      random,
    });
    this.forestGenerator = new ForestGenerator({
      treeGenerator: this.treeGenerator,
      maxTrees: options.config.maxTrees,
      maxRadius: options.config.maxForestRadius,
      spacing: options.config.treeSpacing,
    });
    this.oreGenerator = new OreVeinGenerator({
      arena: options.config.arena,
      surfaceY: options.config.surfaceY,
      maxVeinSize: options.config.maxVeinSize,
      fill,
      random,
    });
  }

  reset(): WorldPlan {
    return this.plans.create(
      "Exact superflat arena reset",
      this.resetGenerator.generateReset(),
    );
  }

  resetTerrain(): WorldPlan {
    return this.plans.create("Reset superflat terrain (agent may be offline)",
      this.resetGenerator.generateTerrainReset());
  }

  clear(): WorldPlan {
    return this.plans.create(
      "Clear entities and blocks above the arena surface",
      this.resetGenerator.generateClear(),
    );
  }

  addTree(
    center: Position,
    radius = this.options.config.treeDefaultRadius,
  ): WorldPlan {
    const tree = this.treeGenerator.generateNear(center, radius);
    return this.plans.create(
      `Oak tree near ${formatHorizontal(center)}`,
      [tree.command],
    );
  }

  addForest(
    center: Position,
    trees: number,
    radius: number,
  ): WorldPlan {
    const forest = this.forestGenerator.generate(
      center,
      trees,
      radius,
    );
    return this.plans.create(
      `Oak forest with ${trees} trees`,
      forest.commands,
    );
  }

  addOre(
    center: Position,
    ore: OreKind,
    size: number,
  ): WorldPlan {
    const vein = this.oreGenerator.generate(center, ore, size);
    return this.plans.create(
      `${ore} ore vein with ${size} blocks in protected stone`,
      vein.commands,
    );
  }
}

function formatHorizontal(position: Position): string {
  return `${Math.round(position.x)},${Math.round(position.z)}`;
}
