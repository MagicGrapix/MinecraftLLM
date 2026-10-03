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
      ? "Take exactly two oak logs from the nearby chest, leave the others inside, keep those two in your inventory, then close the chest. Do not break it."
      : "Put exactly two of your oak logs into the nearby chest, keep the other two in your inventory, then close the chest. Do not break it.",
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
        passed: botDelta === expectedDelta && chestDelta === -expectedDelta && intact && !current.windowOpen,
        expected: `${direction} exactly 2 oak_log; opposite bot/chest inventory deltas; chest intact and window closed`,
        actual: `Bot delta ${botDelta}; chest delta ${chestDelta ?? "unknown"}; intact ${intact}; window open ${current.windowOpen}`,
      };
    },
  };
}

export const interactionScenarios: readonly Scenario[] = [
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
