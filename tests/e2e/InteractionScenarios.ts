import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { blockAt, blockFixture, fixtureFields } from "./ScenarioFixtures";
import type { Observation, Scenario } from "./types";

const stationPosition = (config: WorldBuilderConfig) => ({ x: 3, y: config.surfaceY + 1, z: 0 });
function station(name: string) {
  return fixtureFields((config) => {
    const position = stationPosition(config);
    return blockFixture(config, `Fixed ${name}`, [{ min: position, max: position, name }]);
  });
}

function chestScenario(direction: "withdraw" | "deposit"): Scenario {
  const withdrawing = direction === "withdraw";
  const chestItems: Readonly<Record<string, number>> = withdrawing ? { oak_log: 4 } : {};
  return {
    id: `chest_${direction}`,
    prompt: withdrawing
      ? "Inspect the nearby chest, take exactly two oak logs, leave the others inside, and keep those two in your inventory. Leave the chest closed and intact."
      : "Inspect the nearby chest, put exactly two of your oak logs inside, and keep the other two in your inventory. Leave the chest closed and intact.",
    initialInventory: withdrawing ? {} : { oak_log: 4 },
    ...station("chest"),
    containers: (config) => [{ position: stationPosition(config), items: chestItems }],
    verify: (initial, current) => {
      const before = initial.containers?.[0];
      const after = current.containers?.find((c) => before && c.position.x === before.position.x
        && c.position.y === before.position.y && c.position.z === before.position.z);
      const botDelta = (current.inventory.oak_log ?? 0) - (initial.inventory.oak_log ?? 0);
      const chestDelta = before?.inventory && after?.inventory
        ? (after.inventory.oak_log ?? 0) - (before.inventory.oak_log ?? 0) : null;
      const expectedDelta = withdrawing ? 2 : -2;
      const intact = !!before && blockAt(current, before.position) === "chest";
      return {
        passed: botDelta === expectedDelta && chestDelta === -expectedDelta && intact && !current.windowOpen
          && !!current.successfulTools?.includes("get_chest_contents"),
        expected: `Inspect chest; ${direction} exactly 2 oak_log; opposite bot/chest inventory deltas; chest intact and window closed`,
        actual: `Bot delta ${botDelta}; chest delta ${chestDelta ?? "unknown"}; intact ${intact}; window open ${current.windowOpen}; inspected ${!!current.successfulTools?.includes("get_chest_contents")}`,
      };
    },
  };
}

export const interactionScenarios: readonly Scenario[] = [
  {
    id: "smelt_iron",
    prompt: "Inspect the nearby furnace, smelt the three raw iron in your inventory using your coal, then collect all three iron ingots.",
    timeoutMs: 300_000,
    initialInventory: { raw_iron: 3, coal: 1 },
    ...station("furnace"),
    containers: config => [{ position: stationPosition(config), items: {}, kind: "furnace" }],
    verify: (initial, current) => {
      const before = initial.containers?.[0];
      const after = current.containers?.find(c => before && c.position.x === before.position.x && c.position.y === before.position.y && c.position.z === before.position.z);
      const gained = (current.inventory.iron_ingot ?? 0) - (initial.inventory.iron_ingot ?? 0);
      const consumed = (initial.inventory.raw_iron ?? 0) - (current.inventory.raw_iron ?? 0);
      const intact = !!before && blockAt(current, before.position) === "furnace";
      const cleared = after?.inventory !== undefined && after.inventory !== null &&
        (after.inventory.raw_iron ?? 0) === 0 && (after.inventory.iron_ingot ?? 0) === 0;
      const inspected = !!current.successfulTools?.includes("get_furnace_contents");
      return { passed: gained === 3 && consumed === 3 && intact && cleared && inspected && !current.windowOpen,
        expected: "Inspect furnace; consume 3 raw_iron and collect 3 new iron_ingot; furnace input/output empty, intact and closed",
        actual: `Ingots gained ${gained}; raw iron consumed ${consumed}; intact ${intact}; input/output clear ${cleared}; inspected ${inspected}; window open ${current.windowOpen}` };
    },
  },
  {
    id: "craft_two_wooden_tools",
    prompt: "Use the nearby crafting table and the ingredients in your inventory to craft one wooden axe, then one wooden pickaxe. Keep both tools in your inventory.",
    timeoutMs: 180_000,
    initialInventory: { oak_planks: 6, stick: 4 },
    ...station("crafting_table"),
    verify: (initial, current) => {
      const axe = (current.inventory.wooden_axe ?? 0) - (initial.inventory.wooden_axe ?? 0);
      const pickaxe = (current.inventory.wooden_pickaxe ?? 0) - (initial.inventory.wooden_pickaxe ?? 0);
      const table = initial.blocks.find((b) => b.name === "crafting_table");
      const intact = !!table && blockAt(current, table.position) === "crafting_table";
      return { passed: axe >= 1 && pickaxe >= 1 && intact,
        expected: "Gain 1 wooden_axe and 1 wooden_pickaxe; leave the supplied table intact",
        actual: `Axe gain ${axe}; pickaxe gain ${pickaxe}; table intact ${intact}` };
    },
  },
  {
    id: "craft_wooden_pickaxe",
    prompt: "Use the nearby crafting table and the ingredients in your inventory to craft one wooden pickaxe. Keep the pickaxe in your inventory.",
    initialInventory: { oak_planks: 3, stick: 2 },
    ...station("crafting_table"),
    verify: (initial, current) => {
      const gained = (current.inventory.wooden_pickaxe ?? 0) - (initial.inventory.wooden_pickaxe ?? 0);
      const table = initial.blocks.find((b) => b.name === "crafting_table");
      const intact = !!table && blockAt(current, table.position) === "crafting_table";
      return { passed: gained >= 1 && intact, expected: "Gain 1 wooden_pickaxe and leave the supplied crafting table intact",
        actual: `Gained ${gained} wooden_pickaxe; table intact ${intact}` };
    },
  },
  {
    id: "collect_dropped_logs",
    prompt: "Pick up the four oak logs already lying on the ground nearby and keep them in your inventory. No tree needs to be cut.",
    initialInventory: {},
    drops: (config) => [{ position: { x: 5.5, y: config.surfaceY + 1, z: 0.5 }, item: "oak_log", count: 4 }],
    verify: (initial, current) => {
      const gained = (current.inventory.oak_log ?? 0) - (initial.inventory.oak_log ?? 0);
      const supplied = initial.drops?.reduce((sum, d) => sum + (d.item === "oak_log" ? d.count ?? 0 : 0), 0) ?? 0;
      const remaining = current.drops?.reduce((sum, d) => sum + (d.count ?? 0), 0);
      const known = current.drops !== undefined && current.drops.every((d) => d.item !== null && d.count !== null);
      return { passed: supplied === 4 && gained >= 4 && known && remaining === 0,
        expected: "Pick up the 4 supplied loose oak_log into inventory",
        actual: `Supplied ${supplied}; gained ${gained}; loose items remaining ${known ? remaining : "unknown"}` };
    },
  },
  chestScenario("withdraw"),
  chestScenario("deposit"),
  {
    id: "eat_food",
    prompt: "You are hungry. Eat the cooked beef in your inventory to restore your hunger.",
    initialInventory: { cooked_beef: 1 }, hungry: true,
    verify: (initial: Observation, current: Observation) => {
      const used = (initial.inventory.cooked_beef ?? 0) - (current.inventory.cooked_beef ?? 0);
      const gain = current.food - initial.food;
      return { passed: initial.food < 20 && used === 1 && gain > 0 && current.effects === 0,
        expected: "Consume 1 cooked_beef and increase food with no active status effect",
        actual: `Beef used ${used}; food ${initial.food} -> ${current.food}; active effects ${current.effects}` };
    },
  },
];
