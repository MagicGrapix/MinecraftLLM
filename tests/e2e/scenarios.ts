import { createArenaBounds } from "../../src/devworld/ArenaBounds";
import { WorldPlanFactory } from "../../src/devworld/WorldPlan";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import type { Observation, Scenario } from "./types";
import { interactionScenarios } from "./InteractionScenarios";
import { navigationScenarios } from "./NavigationScenarios";
import { buildingScenarios } from "./BuildingScenarios";
import { blockAt, fixtureFields, ironProgressionMound, stoneMound } from "./ScenarioFixtures";

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

function oakPlan(config: WorldBuilderConfig, trees: readonly TreePosition[]) {
  const y = config.surfaceY + 1;
  return new WorldPlanFactory(config).create(`${trees.length} fixed oak tree(s)`, trees.flatMap(({ x, z }) => [
    { text: `fill ${x - 1} ${y + 2} ${z - 1} ${x + 1} ${y + 4} ${z + 1} minecraft:oak_leaves[persistent=true] replace`, estimatedBlocksChanged: 27,
      affectedBounds: createArenaBounds({ x: x - 1, y: y + 2, z: z - 1 }, { x: x + 1, y: y + 4, z: z + 1 }) },
    { text: `fill ${x} ${y} ${z} ${x} ${y + 3} ${z} minecraft:oak_log[axis=y] replace`, estimatedBlocksChanged: 4,
      affectedBounds: createArenaBounds({ x, y, z }, { x, y: y + 3, z }) },
  ]));
}

function collectLogs(id: string, count: number, prompt: string, trees: readonly TreePosition[]): Scenario {
  return {
    id, prompt, initialInventory: {},
    expectedBlocks: (config) => oakFixture(config, trees),
    fixture: (config) => oakPlan(config, trees),
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

function minedStoneCount(initial: Observation, current: Observation): number {
  return initial.blocks.filter((block) => block.name === "stone" && blockAt(current, block.position) === "air").length;
}

const stoneProgressionTrees = forest.slice(0, 2);
const stoneProgressionFixture = fixtureFields((config) => {
  const mound = stoneMound(config);
  return {
    plan: new WorldPlanFactory(config).create("Two fixed oak trees and a stone mound", [
      ...oakPlan(config, stoneProgressionTrees).commands, ...mound.plan.commands,
    ]),
    blocks: [...oakFixture(config, stoneProgressionTrees), ...mound.blocks],
  };
});

const ironProgressionFixture = fixtureFields((config) => {
  const mound = ironProgressionMound(config);
  return {
    plan: new WorldPlanFactory(config).create("Three fixed oak trees and a stone/coal/iron mound", [
      ...oakPlan(config, forest).commands, ...mound.plan.commands,
    ]),
    blocks: [...oakFixture(config, forest), ...mound.blocks],
  };
});

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
  ...interactionScenarios,
  {
    id: "collect_cobblestone_from_mound",
    prompt: "Use your wooden pickaxe to mine four cobblestone from the nearby stone mound. Collect the drops and keep the four cobblestone in your inventory.",
    timeoutMs: 180_000,
    initialInventory: { wooden_pickaxe: 1 },
    ...fixtureFields(stoneMound),
    verify: (initial, current) => {
      const gained = (current.inventory.cobblestone ?? 0) - (initial.inventory.cobblestone ?? 0);
      const mined = minedStoneCount(initial, current);
      return { passed: gained >= 4 && mined >= 4, expected: "Gain 4 cobblestone and remove at least 4 supplied stone blocks",
        actual: `Cobblestone gain ${gained}; supplied stone blocks removed ${mined}` };
    },
  },
  {
    id: "craft_stone_pickaxe_from_world",
    prompt: "Starting with an empty inventory, craft a wooden pickaxe, then a stone pickaxe using the nearby trees and stone mound. Keep the stone pickaxe in your inventory.",
    timeoutMs: 300_000,
    initialInventory: {},
    ...stoneProgressionFixture,
    verify: (initial, current) => {
      const gained = (current.inventory.stone_pickaxe ?? 0) - (initial.inventory.stone_pickaxe ?? 0);
      const mined = minedStoneCount(initial, current);
      return { passed: Object.keys(initial.inventory).length === 0 && gained >= 1 && mined >= 3,
        expected: "Start empty, gain 1 stone_pickaxe and remove at least 3 supplied stone blocks",
        actual: `Stone pickaxe gain ${gained}; supplied stone blocks removed ${mined}` };
    },
  },
  {
    id: "craft_iron_pickaxe_from_world",
    prompt: "Starting with an empty inventory, craft a stone pickaxe, build and use a furnace, then craft an iron pickaxe using nearby resources. Keep both pickaxes in your inventory.",
    timeoutMs: 600_000,
    initialInventory: {},
    ...ironProgressionFixture,
    verify: (initial, current) => {
      const requiredSources = { oak_log: 1, stone: 11, coal_ore: 1, iron_ore: 3 };
      const removed = Object.entries(requiredSources).map(([name, minimum]) => ({
        name, minimum,
        count: initial.blocks.filter(block => {
          if (block.name !== name) return false;
          const after = blockAt(current, block.position);
          // A workstation placed in a mined cell must not erase evidence of removal.
          return after !== null && after !== name;
        }).length,
      }));
      const stonePickaxe = current.inventory.stone_pickaxe ?? 0;
      const ironPickaxe = current.inventory.iron_pickaxe ?? 0;
      const smelted = current.successfulTools?.includes("use_furnace") === true;
      const startedEmpty = Object.keys(initial.inventory).length === 0;
      return {
        passed: startedEmpty && stonePickaxe >= 1 && ironPickaxe >= 1 && smelted && !current.windowOpen
          && removed.every(source => source.count >= source.minimum),
        expected: "Start empty; keep stone and iron pickaxes; use a furnace successfully and close its window; "
          + "remove at least 1 oak_log, 11 stone, 1 coal_ore and 3 iron_ore from the fixture",
        actual: `Started empty: ${startedEmpty}; stone_pickaxe ${stonePickaxe}; iron_pickaxe ${ironPickaxe}; `
          + `furnace succeeded: ${smelted}; window open: ${current.windowOpen}; removed: `
          + removed.map(source => `${source.name} ${source.count}/${source.minimum}`).join(", "),
      };
    },
  },
  ...navigationScenarios,
  ...buildingScenarios,
  {
    ...collectLogs("checks_axe_from_empty", 0, "Craft one wooden axe starting from your empty inventory. Nearby oak trees are available. Keep the axe in the bot inventory.", forest),
    verify: (initial, current) => {
      const gain = (current.inventory.wooden_axe ?? 0) - (initial.inventory.wooden_axe ?? 0);
      return { passed: gain >= 1, expected: "Gain at least one wooden_axe from empty inventory", actual: `Axe gain: ${gain}` };
    },
  },
  {
    id: "checks_existing_stock",
    prompt: "Make sure your inventory contains at least one wooden axe. If it already does, keep it and do not craft another.",
    initialInventory: { wooden_axe: 1 },
    verify: (initial, current) => ({
      passed: initial.inventory.wooden_axe === 1 && current.inventory.wooden_axe === 1 && Object.keys(current.inventory).length === 1,
      expected: "Preserve the one existing wooden_axe without accumulating other items",
      actual: `Inventory: ${JSON.stringify(current.inventory)}`,
    }),
  },
  {
    ...collectLogs("checks_new_axe", 0, "Craft one additional wooden axe. Keep the existing axe and the new axe in your inventory. Nearby oak trees are available.", forest),
    initialInventory: { wooden_axe: 1 },
    verify: (initial, current) => {
      const gain = (current.inventory.wooden_axe ?? 0) - (initial.inventory.wooden_axe ?? 0);
      return { passed: gain >= 1, expected: "Gain one additional wooden_axe; existing stock alone does not pass", actual: `Axe gain: ${gain}` };
    },
  },
  {
    ...collectLogs("checks_additional_logs", 2, "Collect two additional oak logs from the nearby trees. Keep your existing three logs too, so you finish with at least five.", singleTree),
    initialInventory: { oak_log: 3 },
  },
];
