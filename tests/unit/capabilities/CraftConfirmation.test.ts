import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { CraftFromInventoryCapability } from "../../../src/capabilities/Craft";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { Executor } from "../../../src/execution/Executor";
import { TaskFactory } from "../../../src/execution/TaskFactory";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { fakeCraftBot, fakeRecipe } from "../../support/CraftBot";

const timing = { pollIntervalMs: 2, timeoutMs: 50 };
const recipe = fakeRecipe(5, 4, [{ id: 17, count: -1 }]);
const input = { item: "oak_planks", quantity: 7 };
const counts = (stock: Record<number, number>) => (id: number) => stock[id] ?? 0;
function context(bot: Bot, signal = new AbortController().signal): ExecutionContext {
  return { runtime: { bot }, world: {}, signal, deferCancellationUntil: () => {} } as unknown as ExecutionContext;
}
function assertClean(bot: Bot) {
  for (const event of ["window_items", "set_slot", "set_player_inventory", "set_cursor_item"]) assert.equal(bot._client.listenerCount(event), 0, event);
  for (const event of ["windowOpen", "end", "death", "respawn"] as const) assert.equal(bot.listenerCount(event), 0, event);
}

test("craft waits for each delayed server confirmation, with one resync per recipe and no polling packets", async () => {
  const stock = { 17: 2, 5: 9 };
  let crafts = 0, requests = 0, confirmed = 0;
  const bot = fakeCraftBot({ counts: counts(stock), recipes: [recipe], craft: async () => {
    assert.equal(confirmed, crafts, "Next recipe ran before preceding server confirmation");
    crafts++; stock[17]--; stock[5] += 4;
  }, sync: (respond, n) => {
    requests = n;
    if (n === 1) respond();
    else setTimeout(() => { confirmed++; respond(); }, 10);
  } });
  const result = await new CraftFromInventoryCapability({ ...timing, timeoutMs: 500 }).execute(input, context(bot));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.craftedQuantity, 8);
  assert.equal(result.value.craftOperations, 2);
  assert.equal(requests, 3);
  assert.deepEqual(stock, { 17: 0, 5: 17 });
  assertClean(bot);
});

test("craft rejects predicted output rolled back by the authoritative server inventory", async () => {
  const local = { 17: 2, 5: 0 }, server = { 17: 2, 5: 0 };
  let crafts = 0;
  const bot = fakeCraftBot({ counts: counts(local), serverCounts: counts(server), recipes: [recipe], craft: async () => {
    crafts++; local[17]--; local[5] += 4;
  } });
  const result = await new CraftFromInventoryCapability(timing).execute(input, context(bot));
  assert.ok(!result.ok);
  assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
  assert.equal(result.error.facts?.craftedQuantity, 0);
  assert.equal(result.error.facts?.observedGain, 0);
  assert.equal(crafts, 1);
  assertClean(bot);
});

test("partial craft failure preserves confirmed gain and stops before the next recipe", async () => {
  const local = { 17: 3, 5: 2 }, server = { ...local };
  let crafts = 0;
  const bot = fakeCraftBot({ counts: counts(local), serverCounts: counts(server), recipes: [recipe], craft: async () => {
    crafts++; local[17]--; local[5] += 4;
    if (crafts === 1) Object.assign(server, local);
    else throw new Error("missing ingredient");
  } });
  const result = await new CraftFromInventoryCapability(timing).execute({ ...input, quantity: 12 }, context(bot));
  assert.ok(!result.ok);
  assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
  assert.equal(result.error.facts?.craftedQuantity, 4);
  assert.equal(result.error.facts?.confirmedOperations, 1);
  assert.equal(result.error.facts?.attemptedOperations, 2);
  assert.equal(result.error.facts?.cause, "missing ingredient");
  assert.equal(crafts, 2);
  assertClean(bot);
});

for (const problem of ["ingredients", "unexpected_item", "cursor", "grid"] as const) {
  test(`craft rejects a positive output count with unconfirmed ${problem}`, async () => {
    const stock: Record<number, number> = { 17: 2, 5: 0 };
    const bot = fakeCraftBot({ counts: counts(stock), recipes: [recipe], craft: async () => {
      stock[5] = 4;
      if (problem !== "ingredients") stock[17]!--;
      if (problem === "unexpected_item") stock[58] = 1;
    }, sync: (respond, request) => {
      respond();
      if (request > 1 && problem === "cursor") bot._client.emit("set_cursor_item", { contents: { itemId: 5, itemCount: 4 } });
      if (request > 1 && problem === "grid") bot._client.emit("set_slot", { windowId: 0, slot: 1, item: { itemId: 17, itemCount: 1 } });
    } });
    const result = await new CraftFromInventoryCapability(timing).execute(input, context(bot));
    assert.ok(!result.ok);
    assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
    assert.equal(result.error.facts?.confirmedOperations, 0);
    assertClean(bot);
  });
}

test("unrelated slot updates and other windows cannot replace a full player inventory confirmation", async () => {
  const stock = { 17: 2, 5: 0 };
  let crafts = 0;
  const bot = fakeCraftBot({ counts: counts(stock), recipes: [recipe], craft: async () => { crafts++; }, sync: () => {
    bot._client.emit("set_player_inventory", { slotId: 0, contents: { itemId: 5, itemCount: 8 } });
    bot._client.emit("window_items", { windowId: 1, items: [], carriedItem: { itemCount: 0 } });
  } });
  const result = await new CraftFromInventoryCapability(timing).execute(input, context(bot));
  assert.ok(!result.ok);
  assert.equal(result.error.facts?.stage, "initial_inventory");
  assert.equal(crafts, 0);
  assertClean(bot);
});

test("late relevant server slots complete an initially incomplete craft result", async () => {
  const stock = { 17: 1, 5: 0 };
  const server = { ...stock };
  const bot = fakeCraftBot({ counts: counts(stock), serverCounts: counts(server), recipes: [recipe], craft: async () => {
    stock[17] = 0; stock[5] = 4;
  }, sync: (respond, request) => {
    respond();
    if (request === 2) setTimeout(() => {
      // Initial snapshot has the one log in slot 9; the server replaces it with four planks.
      bot._client.emit("set_slot", { windowId: 0, slot: 9, item: { itemId: 5, itemCount: 4 } });
    }, 5);
  } });
  const result = await new CraftFromInventoryCapability({ ...timing, timeoutMs: 500 }).execute({ ...input, quantity: 4 }, context(bot));
  assert.ok(result.ok, JSON.stringify(result));
  assertClean(bot);
});

test("abort during inventory confirmation stops promptly and detaches observers", async () => {
  const abort = new AbortController();
  const bot = fakeCraftBot({ counts: () => 2, recipes: [recipe], craft: async () => assert.fail(), sync: () => {
    setTimeout(() => abort.abort(new Error("test stop")), 5);
  } });
  await assert.rejects(new CraftFromInventoryCapability().execute(input, context(bot, abort.signal)), /test stop/);
  assertClean(bot);
});

test("disconnect during confirmation gives a structured error and detaches observers", async () => {
  const bot = fakeCraftBot({ counts: () => 2, recipes: [recipe], craft: async () => assert.fail(), sync: () => {
    setTimeout(() => bot.emit("end", "test disconnect"), 5);
  } });
  const result = await new CraftFromInventoryCapability().execute(input, context(bot));
  assert.ok(!result.ok);
  assert.equal(result.error.code, "WORLD_CHANGED");
  assertClean(bot);
});

test("Executor retains the craft lock after stop until the in-flight Mineflayer promise settles", async () => {
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let crafts = 0;
  const bot = fakeCraftBot({ counts: id => id === 17 ? 2 : 0, recipes: [recipe], craft: async () => { crafts++; started(); await pending; } });
  const registry = new CapabilityRegistry(); registry.register(new CraftFromInventoryCapability());
  const ctx = context(bot);
  const executor = new Executor({ runtime: ctx.runtime, world: ctx.world, registry, cancellationGraceMs: 0 });
  const tasks = new TaskFactory();
  const task = () => tasks.create({ capability: "craft_from_inventory_2x2", input });
  const running = executor.execute(task());
  await entered;
  executor.abortCurrent();
  const stopped = await running;
  assert.ok(!stopped.ok);
  assert.equal(stopped.error.code, "INTERRUPTED");
  assert.equal(stopped.error.facts?.stillSettling, true);
  const concurrent = await executor.execute(task());
  assert.ok(!concurrent.ok && concurrent.error.code === "BLOCKED");
  release();
  await executor.waitForIdle(500);
  await delay(0);
  assert.equal(crafts, 1);
  assertClean(bot);
});
