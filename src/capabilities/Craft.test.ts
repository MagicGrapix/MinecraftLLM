import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { Recipe } from "prismarine-recipe";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";
import type { ExecutionContext } from "./Capability";
import { CraftCapability } from "./Craft";

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

  const result = await new CraftCapability().execute(
    { item: "oak_planks", quantity: 4, station: "inventory" },
    createContext(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.craftedQuantity, 4);
    assert.equal(result.value.craftOperations, 1);
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

  const result = await new CraftCapability().execute(
    { item: "oak_planks", quantity: 8, station: "inventory" },
    createContext(bot),
  );

  assert.equal(result.ok, true);
  assert.equal(craftCalls, 2);
});

test("craft limits the requested output quantity", () => {
  const parsed = new CraftCapability().inputSchema.safeParse({
    item: "oak_planks",
    quantity: 65,
    station: "inventory",
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

  const result = await new CraftCapability().execute(
    { item: "oak_planks", quantity: 1, station: "inventory" },
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

  const result = await new CraftCapability().execute(
    {
      item: "wooden_pickaxe",
      quantity: 1,
      station: "crafting_table",
      tablePosition: { x: 10, y: 64, z: 0 },
    },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OUT_OF_REACH");
});

function fakeRecipe(
  resultId: number,
  resultCount: number,
  ingredients: Array<{ id: number; count: number }>,
): Recipe {
  return {
    result: { id: resultId, metadata: null, count: resultCount },
    delta: [
      ...ingredients.map((item) => ({ ...item, metadata: null })),
      { id: resultId, metadata: null, count: resultCount },
    ],
    requiresTable: false,
  } as Recipe;
}

function fakeBot(options: {
  counts: (id: number) => number;
  recipes: Recipe[];
  craft: () => Promise<void>;
  blockAt?: () => unknown;
  canSeeBlock?: () => boolean;
}): Bot {
  const itemsById = {
    5: { id: 5, name: "oak_planks" },
    17: { id: 17, name: "oak_log" },
    18: { id: 18, name: "birch_log" },
    270: { id: 270, name: "wooden_pickaxe" },
  };
  return {
    currentWindow: null,
    entity: {
      position: {
        distanceTo: () => 2,
      },
    },
    registry: {
      itemsByName: {
        oak_planks: itemsById[5],
        wooden_pickaxe: itemsById[270],
      },
      items: itemsById,
    },
    inventory: {
      count: (id: number) => options.counts(id),
      items: () => [
        ...(options.counts(17) > 0
          ? [{ name: "oak_log", count: options.counts(17) }]
          : []),
        ...(options.counts(5) > 0
          ? [{ name: "oak_planks", count: options.counts(5) }]
          : []),
      ],
    },
    recipesAll: () => options.recipes,
    craft: options.craft,
    blockAt: options.blockAt ?? (() => null),
    canSeeBlock: options.canSeeBlock ?? (() => true),
    closeWindow: async () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  } as unknown as Bot;
}

function createContext(bot: Bot): ExecutionContext {
  return {
    runtime: { bot } as unknown as MinecraftRuntime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
    deferCancellationUntil: () => undefined,
  };
}
