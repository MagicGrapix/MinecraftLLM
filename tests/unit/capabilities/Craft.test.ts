import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { CraftFromInventoryCapability, CraftFromTableCapability } from "../../../src/capabilities/Craft";
import { fakeCraftBot as fakeBot, fakeRecipe } from "../../support/CraftBot";

test("craft verifies the produced inventory quantity", async () => {
  let logs = 1;
  let planks = 0;
  const recipe = fakeRecipe(5, 4, [{ id: 17, count: -1 }]);
  const bot = fakeBot({
    counts: (id) => (id === 17 ? logs : id === 5 ? planks : 0),
    recipes: [recipe],
    craft: async () => {
      logs -= 1;
      planks += 4;
    },
  });

  const result = await new CraftFromInventoryCapability().execute(
    { item: "oak_planks", quantity: 4 },
    createContext(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.craftedQuantity, 4);
    assert.equal(result.value.craftOperations, 1);
    assert.equal(result.value.station, "inventory");
  }
});

test("craft performs one bounded operation at a time", async () => {
  let logs = 2;
  let planks = 0;
  let craftCalls = 0;
  const recipe = fakeRecipe(5, 4, [{ id: 17, count: -1 }]);
  const bot = fakeBot({
    counts: (id) => (id === 17 ? logs : id === 5 ? planks : 0),
    recipes: [recipe],
    craft: async () => {
      craftCalls += 1;
      logs -= 1;
      planks += 4;
    },
  });

  const result = await new CraftFromInventoryCapability().execute(
    { item: "oak_planks", quantity: 8 },
    createContext(bot),
  );

  assert.equal(result.ok, true);
  assert.equal(craftCalls, 2);
});

test("craft limits the requested output quantity", () => {
  const parsed = new CraftFromInventoryCapability().inputSchema.safeParse({
    item: "oak_planks",
    quantity: 65,
  });

  assert.equal(parsed.success, false);
});

test("craft reports the deterministic recipe with least missing items", async () => {
  const expensive = fakeRecipe(5, 1, [{ id: 17, count: -3 }]);
  const cheapest = fakeRecipe(5, 1, [{ id: 18, count: -1 }]);
  const bot = fakeBot({
    counts: () => 0,
    recipes: [expensive, cheapest],
    craft: async () => assert.fail("craft must not run"),
  });

  const result = await new CraftFromInventoryCapability().execute(
    { item: "oak_planks", quantity: 1 },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "MISSING_ITEM");
    const missing = result.error.facts?.missingIngredients as Array<{
      item: string;
      missing: number;
    }>;
    assert.deepEqual(missing, [{ item: "birch_log", required: 1, available: 0, missing: 1 }]);
  }
});

test("crafting table station never navigates to an unreachable table", async () => {
  const table = {
    name: "crafting_table",
    stateId: 1,
    position: { x: 10, y: 64, z: 0 },
  };
  const bot = fakeBot({
    counts: () => 1,
    recipes: [],
    craft: async () => assert.fail("craft must not run"),
    blockAt: () => table,
    canSeeBlock: () => false,
  });

  const result = await new CraftFromTableCapability().execute(
    {
      item: "wooden_pickaxe",
      quantity: 1,
      tablePosition: { x: 10, y: 64, z: 0 },
    },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OUT_OF_REACH");
});

test("craft tools validate simple station-free inputs without coercing quantity or coordinates", () => {
  const inventory = new CraftFromInventoryCapability().inputSchema;
  const table = new CraftFromTableCapability().inputSchema;
  const input = { item: "oak_planks", quantity: 4 };
  const tableInput = { ...input, tablePosition: { x: 2, y: -60, z: 5 } };
  assert.equal(inventory.safeParse(input).success, true);
  assert.equal(table.safeParse(tableInput).success, true);
  for (const quantity of ["4", 0, -1, 1.5, 65]) {
    assert.equal(inventory.safeParse({ ...input, quantity }).success, false);
    assert.equal(table.safeParse({ ...tableInput, quantity }).success, false);
  }
  assert.equal(inventory.safeParse({}).success, false);
  assert.equal(table.safeParse(input).success, false);
  assert.equal(inventory.safeParse(tableInput).success, false);
  assert.equal(inventory.safeParse({ ...input, station: "inventory" }).success, false);
  assert.equal(table.safeParse({ ...tableInput, station: "crafting_table" }).success, false);
  assert.equal(table.safeParse({ ...tableInput, tablePosition: "2,-60,5" }).success, false);
  assert.equal(table.safeParse({ ...tableInput, tablePosition: { x: 2.5, y: -60, z: 5 } }).success, false);
});

test("inventory crafting rejects recipes requiring a table without executing them", async () => {
  const recipe = { ...fakeRecipe(270, 1, [{ id: 5, count: -3 }]), requiresTable: true };
  const bot = fakeBot({ counts: () => 3, recipes: [recipe], craft: async () => assert.fail("No craft must run") });
  const result = await new CraftFromInventoryCapability().execute({ item: "wooden_pickaxe", quantity: 1 }, createContext(bot));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RECIPE_NOT_FOUND");
});

test("table crafting passes the observed table to Mineflayer for both 2x2 and 3x3 recipes", async () => {
  const table = { name: "crafting_table", stateId: 1, position: { x: 2, y: 64, z: 0 } };
  for (const requiresTable of [false, true]) {
    let produced = 0;
    let materials = 3;
    const recipe = { ...fakeRecipe(270, 1, [{ id: 5, count: -3 }]), requiresTable };
    const bot = fakeBot({
      counts: (id) => id === 5 ? materials : id === 270 ? produced : 0,
      recipes: [recipe],
      craft: async () => undefined,
      blockAt: () => table,
    });
    bot.recipesAll = (id, metadata, observedTable) => {
      assert.equal(observedTable, table);
      return [recipe];
    };
    bot.craft = async (chosenRecipe, operations, observedTable) => {
      assert.equal(chosenRecipe, recipe);
      assert.equal(operations, 1);
      assert.equal(observedTable, table);
      produced += 1;
      materials -= 3;
    };
    const result = await new CraftFromTableCapability().execute({
      item: "wooden_pickaxe", quantity: 1, tablePosition: { x: 2, y: 64, z: 0 },
    }, createContext(bot));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.station, "crafting_table");
      assert.equal(result.value.craftedQuantity, 1);
    }
  }
});

test("table crafting rejects a missing table before crafting", async () => {
  const bot = fakeBot({ counts: () => 4, recipes: [], craft: async () => assert.fail("No craft must run") });
  const result = await new CraftFromTableCapability().execute({
    item: "oak_planks", quantity: 4, tablePosition: { x: 2, y: 64, z: 0 },
  }, createContext(bot));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TARGET_NOT_FOUND");
});

test("inventory crafting turns one log into planks then a table without station arguments", async () => {
  const counts: Record<number, number> = { 17: 1 };
  const planks = fakeRecipe(5, 4, [{ id: 17, count: -1 }]);
  const table = fakeRecipe(58, 1, [{ id: 5, count: -4 }]);
  const bot = fakeBot({ counts: id => counts[id] ?? 0, recipes: [], craft: async () => undefined });
  bot.recipesAll = (id, metadata, observedTable) => {
    assert.equal(observedTable, null);
    return id === 5 ? [planks] : [table];
  };
  bot.craft = async (recipe, operations, observedTable) => {
    assert.equal(operations, 1);
    assert.equal(observedTable, undefined);
    for (const delta of recipe.delta) counts[delta.id] = (counts[delta.id] ?? 0) + delta.count;
  };
  const capability = new CraftFromInventoryCapability();
  assert.equal((await capability.execute({ item: "oak_planks", quantity: 4 }, createContext(bot))).ok, true);
  assert.equal((await capability.execute({ item: "crafting_table", quantity: 1 }, createContext(bot))).ok, true);
  assert.deepEqual(counts, { 17: 0, 5: 0, 58: 1 });
});

function createContext(bot: Bot): ExecutionContext {
  return {
    runtime: { bot } as unknown as MinecraftRuntime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
    deferCancellationUntil: () => undefined,
  };
}
