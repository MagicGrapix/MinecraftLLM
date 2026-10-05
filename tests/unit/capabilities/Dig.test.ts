import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { DigCapability } from "../../../src/capabilities/Dig";

const oak = { name: "oak_log", stateId: 1, boundingBox: "block" };
const air = { name: "air", stateId: 0, boundingBox: "empty" };
const position = { x: 3, y: -60, z: 0 };

function harness() {
  let block: typeof oak | null = oak;
  const client = new EventEmitter();
  const calls: unknown[][] = [], ticks: number[] = [];
  const bot = Object.assign(new EventEmitter(), {
    _client: client, entity: { onGround: false }, heldItem: null, targetDigBlock: null,
    blockAt: () => block, canDigBlock: () => true, digTime: () => bot.entity.onGround ? 3000 : 15000,
    waitForTicks: async (count: number) => { ticks.push(count); bot.entity.onGround = true; },
    dig: async (...args: unknown[]) => { calls.push(args); block = air; },
    stopDigging: () => undefined,
  });
  const abort = new AbortController();
  const context = { runtime: { bot }, world: {}, signal: abort.signal, deferCancellationUntil: () => undefined } as unknown as ExecutionContext;
  return {
    bot, client, calls, ticks, abort, setBlock: (value: typeof oak | null) => { block = value; },
    run: () => new DigCapability(10).execute({ position }, context),
    confirm: () => client.emit("block_change", { location: position, type: 0 }),
  };
}

test("dig waits for ground, raycasts the expected block and requires a server update", async () => {
  const h = harness();
  const original = h.bot.dig;
  h.bot.dig = async (...args) => { assert.equal(h.bot.entity.onGround, true); await original(...args); h.confirm(); };
  const result = await h.run();
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.value.block, "oak_log"); assert.equal(result.value.tool, "hand"); assert.equal(result.value.estimatedDurationMs, 3000); }
  assert.deepEqual(h.ticks, [1]);
  assert.deepEqual(h.calls, [[oak, false, "raycast"]]);
  assert.equal(h.client.listenerCount("block_change"), 0);
});

test("dig rejects a target changed while landing", async () => {
  const h = harness();
  h.bot.waitForTicks = async () => { h.bot.entity.onGround = true; h.setBlock({ ...oak, name: "birch_log", stateId: 2 }); };
  const result = await h.run();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "WORLD_CHANGED");
  assert.equal(h.calls.length, 0);
});

test("optimistic client air and local blockUpdate events alone cannot prove digging", async () => {
  const h = harness();
  const original = h.bot.dig;
  h.bot.dig = async (...args) => { await original(...args); h.bot.emit("blockUpdate", oak, air); };
  const result = await h.run();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
  assert.equal(h.client.listenerCount("multi_block_change"), 0);
});

test("dig reports BLOCKED when server restores target after optimistic removal", async () => {
  const h = harness(), original = h.bot.dig;
  h.bot.dig = async (...args) => {
    await original(...args);
    setImmediate(() => { h.setBlock(oak); h.client.emit("block_change", { location: position, type: 1 }); });
  };
  const result = await h.run();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "BLOCKED");
});

test("an unobservable cell after digging is unknown, not success", async () => {
  const h = harness();
  h.bot.dig = async () => { h.setBlock(null); };
  const result = await h.run();
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.code, "WORLD_CHANGED"); assert.equal(result.error.facts?.verification, "unknown"); }
});

test("dig accepts packed server section updates at negative Y", async () => {
  const h = harness(), original = h.bot.dig;
  h.bot.dig = async (...args) => {
    await original(...args);
    h.client.emit("multi_block_change", { chunkCoordinates: { x: 0, y: -4, z: 0 }, records: [(3 << 8) | 4] });
  };
  assert.equal((await h.run()).ok, true);
});

test("aborting server verification rejects and releases all packet listeners", async () => {
  const h = harness();
  h.bot.dig = async () => { h.setBlock(air); setImmediate(() => h.abort.abort(new Error("Stopped"))); };
  await assert.rejects(h.run(), /Stopped/);
  assert.equal(h.client.listenerCount("block_change"), 0);
  assert.equal(h.bot.listenerCount("end"), 0);
});
