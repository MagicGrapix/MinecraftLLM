import { createArenaBounds } from "../../src/devworld/ArenaBounds";
import { WorldPlanFactory } from "../../src/devworld/WorldPlan";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import type { Scenario } from "./types";

/** Fixed geometry, no feature RNG, saplings or leaf decay. */
export function oakFixture(config: WorldBuilderConfig) {
  const y = config.surfaceY + 1;
  const blocks = new Map<string, { position: { x: number; y: number; z: number }; name: string }>();
  const put = (x: number, h: number, z: number, name: string) => {
    blocks.set(`${x},${h},${z}`, { position: { x, y: h, z }, name });
  };
  for (let h = y + 2; h <= y + 4; h++) {
    for (let x = 4; x <= 6; x++) for (let z = -1; z <= 1; z++) put(x, h, z, "oak_leaves");
  }
  for (let h = y; h <= y + 3; h++) put(5, h, 0, "oak_log");
  return [...blocks.values()];
}

const wood: Scenario = {
  id: "collect_two_logs",
  prompt: "Collect two oak logs and keep them in your inventory.",
  initialInventory: {},
  expectedBlocks: oakFixture,
  fixture: (config) => {
    const y = config.surfaceY + 1;
    return new WorldPlanFactory(config).create("Fixed oak tree", [
      { text: `fill 4 ${y + 2} -1 6 ${y + 4} 1 minecraft:oak_leaves[persistent=true] replace`, estimatedBlocksChanged: 27,
        affectedBounds: createArenaBounds({ x: 4, y: y + 2, z: -1 }, { x: 6, y: y + 4, z: 1 }) },
      { text: `fill 5 ${y} 0 5 ${y + 3} 0 minecraft:oak_log[axis=y] replace`, estimatedBlocksChanged: 4,
        affectedBounds: createArenaBounds({ x: 5, y, z: 0 }, { x: 5, y: y + 3, z: 0 }) },
    ]);
  },
  verify: (initial, current) => {
    const gained = (current.inventory.oak_log ?? 0) - (initial.inventory.oak_log ?? 0);
    return { passed: gained >= 2, expected: "Gain at least 2 oak_log in the bot inventory", actual: `Gained ${gained} oak_log` };
  },
};

export const scenarios: readonly Scenario[] = [
  {
    id: "craft_table",
    prompt: "Craft one crafting table using the planks in your inventory. Keep the table in your inventory.",
    initialInventory: { oak_planks: 4 },
    verify: (initial, current) => {
      const gained = (current.inventory.crafting_table ?? 0) - (initial.inventory.crafting_table ?? 0);
      return { passed: gained >= 1, expected: "Gain 1 crafting_table in the bot inventory", actual: `Gained ${gained} crafting_table` };
    },
  },
  wood,
];
