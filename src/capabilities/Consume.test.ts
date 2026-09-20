import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";
import type { ExecutionContext } from "./Capability";
import { ConsumeCapability } from "./Consume";

test("consume requires an observable inventory or state change", async () => {
  let breadCount = 2;
  let food = 12;
  let deactivateCalls = 0;
  const heldItem = { name: "bread", count: 2, metadata: 0, slot: 36 };
  const bot = {
    heldItem,
    usingHeldItem: false,
    health: 20,
    get food() {
      return food;
    },
    entity: { effects: {} },
    registry: { foodsByName: { bread: { name: "bread" } } },
    inventory: {
      slots: [],
      items: () =>
        breadCount > 0 ? [{ ...heldItem, count: breadCount }] : [],
    },
    activateItem: () => undefined,
    deactivateItem: () => {
      deactivateCalls += 1;
    },
    waitForTicks: async () => {
      breadCount = 1;
      food = 17;
    },
  } as unknown as Bot;

  const result = await new ConsumeCapability().execute(
    { expectedItem: "bread", hand: "hand" },
    createContext(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.foodBefore, 12);
    assert.equal(result.value.foodAfter, 17);
    assert.equal(result.value.countAfter, 1);
  }
  assert.equal(deactivateCalls, 1);
});

test("consume rejects an item that is not consumable", async () => {
  const bot = {
    heldItem: { name: "stick", count: 1 },
    usingHeldItem: false,
    registry: { foodsByName: {} },
    inventory: { slots: [], items: () => [{ name: "stick", count: 1 }] },
  } as unknown as Bot;

  const result = await new ConsumeCapability().execute(
    { expectedItem: "stick", hand: "hand" },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "NOT_CONSUMABLE");
});

test("usingHeldItem alone never confirms consumption", async () => {
  const heldItem = { name: "potion", count: 1, metadata: 0, slot: 36 };
  let usingHeldItem = false;
  const bot = {
    heldItem,
    get usingHeldItem() {
      return usingHeldItem;
    },
    food: 20,
    health: 20,
    entity: { effects: {} },
    registry: { foodsByName: {} },
    inventory: { slots: [], items: () => [heldItem] },
    activateItem: () => {
      usingHeldItem = true;
    },
    deactivateItem: () => undefined,
    waitForTicks: async () => undefined,
  } as unknown as Bot;

  const result = await new ConsumeCapability().execute(
    { expectedItem: "potion", hand: "hand" },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
});

function createContext(bot: Bot): ExecutionContext {
  return {
    runtime: { bot } as unknown as MinecraftRuntime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
  };
}
