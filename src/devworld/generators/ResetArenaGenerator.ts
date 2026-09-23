import { createArenaBounds, type ArenaBounds } from "../ArenaBounds";
import {
  DEV_WORLD_BLOCKS,
  flatLayerProfile,
} from "../BlockCatalog";
import type { PlannedCommand } from "../WorldPlan";
import { FillCommandGenerator } from "./FillCommandGenerator";

export interface ResetArenaGeneratorOptions {
  readonly arena: ArenaBounds;
  readonly surfaceY: number;
  readonly agentUsername: string;
  readonly fill: FillCommandGenerator;
}

export class ResetArenaGenerator {
  constructor(private readonly options: ResetArenaGeneratorOptions) {}

  generateReset(): readonly PlannedCommand[] {
    const profile = flatLayerProfile(this.options.surfaceY);
    const commands: PlannedCommand[] = [
      entityCleanupCommand(this.options.arena),
      ...this.options.fill.generate(
        this.options.arena,
        DEV_WORLD_BLOCKS.air,
      ),
      ...this.options.fill.generate(
        horizontalLayer(this.options.arena, profile.bedrockY),
        DEV_WORLD_BLOCKS.bedrock,
      ),
      ...this.options.fill.generate(
        horizontalLayer(this.options.arena, profile.lowerDirtY),
        DEV_WORLD_BLOCKS.dirt,
      ),
      ...this.options.fill.generate(
        horizontalLayer(this.options.arena, profile.upperDirtY),
        DEV_WORLD_BLOCKS.dirt,
      ),
      ...this.options.fill.generate(
        horizontalLayer(this.options.arena, profile.grassY),
        DEV_WORLD_BLOCKS.grass,
      ),
      globalCommand(`clear ${this.options.agentUsername}`),
      globalCommand(
        `effect clear ${this.options.agentUsername}`,
      ),
      globalCommand(
        `gamemode survival ${this.options.agentUsername}`,
      ),
      globalCommand(
        `tp ${this.options.agentUsername} 0 ${profile.airY} 0`,
      ),
      globalCommand("time set day"),
      globalCommand("weather clear"),
    ];
    return commands;
  }

  generateClear(): readonly PlannedCommand[] {
    const aboveSurface = createArenaBounds(
      {
        x: this.options.arena.min.x,
        y: this.options.surfaceY + 1,
        z: this.options.arena.min.z,
      },
      this.options.arena.max,
    );
    return [
      entityCleanupCommand(this.options.arena),
      ...this.options.fill.generate(
        aboveSurface,
        DEV_WORLD_BLOCKS.air,
      ),
    ];
  }
}

function horizontalLayer(
  arena: ArenaBounds,
  y: number,
): ArenaBounds {
  return createArenaBounds(
    { x: arena.min.x, y, z: arena.min.z },
    { x: arena.max.x, y, z: arena.max.z },
  );
}

function entityCleanupCommand(bounds: ArenaBounds): PlannedCommand {
  return {
    text:
      `kill @e[type=!minecraft:player,x=${bounds.min.x},y=${bounds.min.y},z=${bounds.min.z},` +
      `dx=${bounds.max.x - bounds.min.x},dy=${bounds.max.y - bounds.min.y},dz=${bounds.max.z - bounds.min.z}]`,
    estimatedBlocksChanged: 0,
    affectedBounds: bounds,
  };
}

function globalCommand(text: string): PlannedCommand {
  return { text, estimatedBlocksChanged: 0 };
}
