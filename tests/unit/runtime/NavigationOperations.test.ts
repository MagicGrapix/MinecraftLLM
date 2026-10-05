import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { NavigationOperations } from "../../../src/runtime/NavigationOperations";

test("aborted navigation owns pending equip and blocks pathfinder's late dig continuation", async () => {
  let release!: () => void, digs = 0, stopped = 0;
  const bot = Object.assign(new EventEmitter(), {
    equip: async () => new Promise<void>((resolve) => { release = resolve; }),
    dig: async () => { digs++; }, stopDigging: () => { stopped++; }, clearControlStates: () => undefined,
    pathfinder: { goal: null, setGoal: () => undefined },
  });
  const originalEquip = bot.equip, abort = new AbortController(), barriers: Promise<unknown>[] = [];
  const scope = new NavigationOperations(bot as unknown as Bot, abort.signal, (promise) => barriers.push(promise));
  // The library catches failed equips and still attempts dig; the guard must cover that too.
  const chain = bot.equip().catch(() => undefined).then(() => bot.dig()).catch(() => undefined);
  await tick();
  abort.abort();
  let finished = false;
  const completion = scope.finish().then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  release();
  await completion; await chain;
  assert.equal(digs, 0);
  assert.equal(barriers.length, 2);
  assert.ok(stopped > 0);
  assert.equal(bot.equip, originalEquip);
  assert.equal(bot.listenerCount("end"), 0);
});

test("pending place settles before method restoration even if resetting the goal throws", async () => {
  let release!: () => void;
  const bot = Object.assign(new EventEmitter(), {
    placeBlock: async () => new Promise<void>((resolve) => { release = resolve; }),
    stopDigging: () => undefined, clearControlStates: () => undefined,
    pathfinder: { goal: {}, setGoal: () => { throw new Error("reset failed"); } },
  });
  const original = bot.placeBlock;
  const scope = new NavigationOperations(bot as unknown as Bot, new AbortController().signal, () => undefined);
  const placement = bot.placeBlock().catch(() => undefined);
  await tick();
  const done = assert.rejects(scope.finish(), /reset failed/);
  await tick();
  assert.notEqual(bot.placeBlock, original);
  release(); await done; await placement;
  assert.equal(bot.placeBlock, original);
});
