import { createArenaBounds } from "../../src/devworld/ArenaBounds";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { WorldPlanFactory } from "../../src/devworld/WorldPlan";
import type { Position } from "../../src/shared/types";
import type { ExpectedBlock } from "./TerrainVerification";
import type { Scenario } from "./types";

export interface Region { min: Position; max: Position; name: string }

/** Small fixed regions: commands and expected cells come from the same geometry. */
export function blockFixture(config: WorldBuilderConfig, description: string, regions: readonly Region[]) {
  const cells = new Map<string, ExpectedBlock>();
  const commands = regions.map(({ min, max, name }) => {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Invalid fixture block name.");
    const bounds = createArenaBounds(min, max);
    const count = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
    if (count > config.maxFillBlocks) throw new Error("Scenario fixture exceeds the fill limit.");
    for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) cells.set(`${x},${y},${z}`, { position: { x, y, z }, name });
    }
    return { text: `fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} minecraft:${name} replace`,
      estimatedBlocksChanged: count, affectedBounds: bounds };
  });
  return { plan: new WorldPlanFactory(config).create(description, commands), blocks: [...cells.values()] };
}

export function blockAt(observed: { blocks: readonly { position: Position; name: string | null }[] }, position: Position): string | null {
  return observed.blocks.find((b) => b.position.x === position.x && b.position.y === position.y && b.position.z === position.z)?.name ?? null;
}

export function fixtureFields(build: (config: WorldBuilderConfig) => ReturnType<typeof blockFixture>): Pick<Scenario, "fixture" | "expectedBlocks" | "observeBlocks"> {
  return { fixture: (config) => build(config).plan, expectedBlocks: (config) => build(config).blocks,
    observeBlocks: (config) => build(config).blocks.map((b) => b.position) };
}

/** A walkable grass/dirt mound with nine exposed stone blocks, shared by the resource scenarios. */
export function stoneMound(config: WorldBuilderConfig) {
  const y = config.surfaceY;
  return blockFixture(config, "Fixed dirt mound with exposed stone", [
    // Cover first, then put dirt underneath: exposed dirt must not spread grass during setup.
    { min: { x: 9, y: y + 2, z: 6 }, max: { x: 11, y: y + 2, z: 8 }, name: "stone" },
    { min: { x: 8, y: y + 1, z: 5 }, max: { x: 12, y: y + 1, z: 9 }, name: "grass_block" },
    { min: { x: 9, y: y + 1, z: 6 }, max: { x: 11, y: y + 1, z: 8 }, name: "dirt" },
    { min: { x: 8, y, z: 5 }, max: { x: 12, y, z: 9 }, name: "dirt" },
  ]);
}
