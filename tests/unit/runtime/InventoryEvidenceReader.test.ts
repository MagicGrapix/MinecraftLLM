import assert from "node:assert/strict";
import test from "node:test";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import { createInventoryEvidenceReader } from "../../../src/runtime/InventoryEvidenceReader";
import type { Executor } from "../../../src/execution/Executor";
import { fakeCraftBot } from "../../support/CraftBot";

function harness(sync?: Parameters<typeof fakeCraftBot>[0]["sync"]) {
  const bot = fakeCraftBot({ counts: () => 99, serverCounts: () => 0, recipes: [], craft: async () => { throw new Error("Must not craft"); }, sync });
  bot.health = 20;
  const runtime = { bot, isConnected: true };
  const executor: Pick<Executor, "currentTask"> = { currentTask: null };
  const read = createInventoryEvidenceReader(runtime as MinecraftRuntime, executor, { pollIntervalMs: 2, timeoutMs: 30 });
  return { bot, runtime, executor, read };
}

test("uses confirmed storage/hotbar only, aggregates stacks, ignores predicted stock and nonstorage slots", async () => {
  const h = harness(() => {
    const items = Array.from({ length: 46 }, () => ({ itemCount: 0, itemId: 0 }));
    for (const slot of [0, 1, 5, 45]) items[slot] = { itemCount: 30, itemId: 5 };
    items[9] = { itemCount: 3, itemId: 5 };
    items[36] = { itemCount: 4, itemId: 5 };
    h.bot._client.emit("window_items", { windowId: 0, items, carriedItem: { itemId: 5, itemCount: 30 } });
  });
  try {
    assert.deepEqual(await h.read(new AbortController().signal), { known: true, items: { oak_planks: 7 } });
    assert.equal(h.bot._client.listenerCount("window_items"), 0);
  } finally { h.read.dispose(); }
  assert.equal(h.bot.listenerCount("respawn"), 0);
});

test("known empty is distinct from disconnected, dead, still settling and open-container observations", async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.read(new AbortController().signal), { known: true, items: {} });
    h.runtime.isConnected = false;
    assert.equal((await h.read(new AbortController().signal)).known, false);
    h.runtime.isConnected = true;
    h.bot.health = 0;
    assert.equal((await h.read(new AbortController().signal)).known, false);
    h.bot.health = 20;
    Object.assign(h.executor, { currentTask: { id: "settling" } });
    const settling = await h.read(new AbortController().signal);
    assert.ok(!settling.known && settling.reason === "ACTION_IN_PROGRESS");
    Object.assign(h.executor, { currentTask: null });
    Object.assign(h.bot, { currentWindow: { id: 1 } });
    const open = await h.read(new AbortController().signal);
    assert.ok(!open.known && open.reason === "CONTAINER_OPEN");
    assert.notEqual(h.bot.currentWindow, null, "Reader must not close the container");
  } finally { h.read.dispose(); }
});

for (const event of ["end", "death", "respawn"] as const) test(`${event} during confirmation invalidates even a received snapshot until next spawn`, async () => {
  const h = harness(respond => { respond(); if (event === "end") h.bot.emit("end", "Disconnected"); else h.bot.emit(event); });
  try {
    assert.equal((await h.read(new AbortController().signal)).known, false);
    assert.equal((await h.read(new AbortController().signal)).known, false);
    assert.equal(h.bot._client.listenerCount("window_items"), 0);
  } finally { h.read.dispose(); }
});

test("timeout stays unknown and cancellation propagates without listener leaks", async () => {
  const h = harness(() => {});
  try {
    const timedOut = await h.read(new AbortController().signal);
    assert.ok(!timedOut.known && timedOut.reason === "OBSERVATION_TIMEOUT");
    const abort = new AbortController();
    const pending = h.read(abort.signal);
    abort.abort(new Error("Stop"));
    await assert.rejects(pending, /Stop/);
    assert.equal(h.bot._client.listenerCount("window_items"), 0);
  } finally { h.read.dispose(); }
});

test("a new spawn permits a fresh observation after respawn, but disposal does not", async () => {
  const h = harness();
  try {
    h.bot.emit("respawn");
    assert.equal((await h.read(new AbortController().signal)).known, false);
    h.bot.emit("spawn");
    assert.deepEqual(await h.read(new AbortController().signal), { known: true, items: {} });
    h.read.dispose();
    h.bot.emit("spawn");
    assert.equal((await h.read(new AbortController().signal)).known, false);
  } finally { h.read.dispose(); }
});
