import { createArenaBounds } from "../../src/devworld/ArenaBounds";
import { WorldPlanFactory } from "../../src/devworld/WorldPlan";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import type { Observation, Scenario } from "./types";

type TreePosition = { x: number; z: number };
const singleTree: readonly TreePosition[] = [{ x: 5, z: 0 }];
const forest: readonly TreePosition[] = [...singleTree, { x: -5, z: 4 }, { x: 3, z: 9 }];

/** Fixed geometry, no feature RNG, saplings or leaf decay. */
export function oakFixture(config: WorldBuilderConfig, trees: readonly TreePosition[] = singleTree) {
  const y = config.surfaceY + 1;
  const blocks = new Map<string, { position: { x: number; y: number; z: number }; name: string }>();
  const put = (x: number, h: number, z: number, name: string) => {
    blocks.set(`${x},${h},${z}`, { position: { x, y: h, z }, name });
  };
  for (const tree of trees) {
    for (let h = y + 2; h <= y + 4; h++) {
      for (let x = tree.x - 1; x <= tree.x + 1; x++) {
        for (let z = tree.z - 1; z <= tree.z + 1; z++) put(x, h, z, "oak_leaves");
      }
    }
    for (let h = y; h <= y + 3; h++) put(tree.x, h, tree.z, "oak_log");
  }
  return [...blocks.values()];
}

function collectLogs(id: string, count: number, prompt: string, trees: readonly TreePosition[]): Scenario {
  return {
    id, prompt, initialInventory: {},
    expectedBlocks: (config) => oakFixture(config, trees),
    fixture: (config) => {
      const y = config.surfaceY + 1;
      return new WorldPlanFactory(config).create(`${trees.length} fixed oak tree(s)`, trees.flatMap(({ x, z }) => [
        { text: `fill ${x - 1} ${y + 2} ${z - 1} ${x + 1} ${y + 4} ${z + 1} minecraft:oak_leaves[persistent=true] replace`, estimatedBlocksChanged: 27,
          affectedBounds: createArenaBounds({ x: x - 1, y: y + 2, z: z - 1 }, { x: x + 1, y: y + 4, z: z + 1 }) },
        { text: `fill ${x} ${y} ${z} ${x} ${y + 3} ${z} minecraft:oak_log[axis=y] replace`, estimatedBlocksChanged: 4,
          affectedBounds: createArenaBounds({ x, y, z }, { x, y: y + 3, z }) },
      ]));
    },
    verify: (initial, current) => {
      const gained = (current.inventory.oak_log ?? 0) - (initial.inventory.oak_log ?? 0);
      return { passed: gained >= count, expected: `Gain at least ${count} oak_log in the bot inventory`, actual: `Gained ${gained} oak_log` };
    },
  };
}

/** TestWorld always starts the bot at (0.5, surfaceY+1, 0.5), facing south (+Z). */
function frontBlock(initial: Observation, current: Observation): string | null {
  const x = Math.floor(initial.position.x);
  // Setup accepts tiny physics rounding around the integer standing height.
  const y = Math.round(initial.position.y);
  const z = Math.floor(initial.position.z) + 1;
  return current.blocks.find((block) => block.position.x === x && block.position.y === y && block.position.z === z)?.name ?? null;
}

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
  collectLogs("collect_two_logs", 2, "Collect two oak logs and keep them in your inventory.", singleTree),
  collectLogs("collect_four_logs", 4, "Collect four oak log blocks from the nearby trees and keep them in your inventory.", forest),
  {
    id: "place_block_in_front",
    prompt: "Place the oak planks block from your inventory on the ground directly in front of where you are standing now.",
    initialInventory: { oak_planks: 1 },
    observeBlocks: (config) => [{ x: 0, y: config.surfaceY + 1, z: 1 }],
    verify: (initial, current) => {
      const before = frontBlock(initial, initial);
      const after = frontBlock(initial, current);
      const used = (initial.inventory.oak_planks ?? 0) - (current.inventory.oak_planks ?? 0);
      return {
        passed: before === "air" && after === "oak_planks" && used === 1,
        expected: "Place 1 oak_planks in the initially empty cell directly south of the starting feet position; consume 1 inventory block",
        actual: `Front cell: ${before ?? "unknown"} -> ${after ?? "unknown"}; inventory oak_planks used: ${used}`,
      };
    },
  },
];
