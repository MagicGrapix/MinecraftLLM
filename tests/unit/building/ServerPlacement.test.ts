import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { ServerBlockObservation } from "../../../src/runtime/ServerBlockObservation";
import { testBlock } from "../../support/building";

test("placement confirmation requires an inbound server state, not just local prediction", async () => {
  const position = new Vec3(0, 0, 0), client = new EventEmitter();
  let block = testBlock("oak_planks", position);
  const bot = Object.assign(new EventEmitter(), { _client: client, blockAt: () => block }) as unknown as Bot;
  const watcher = new ServerBlockObservation(bot, position);
  const expected = (b: typeof block) => b.name === "oak_planks";
  try {
    assert.equal(watcher.matches(expected), false);
    await watcher.wait(new AbortController().signal, 5, expected);
    assert.equal(watcher.matches(expected), false);
    client.emit("block_change", { location: position, type: 1 });
    assert.equal(watcher.matches(expected), true);
    block = testBlock("air", position); client.emit("block_change", { location: position, type: 0 });
    assert.equal(watcher.matches(expected), false);
  } finally { watcher.dispose(); }
  assert.equal(client.listenerCount("block_change"), 0);
});

test("confirmation waits through an unrelated state then accepts the expected server block", async () => {
  const position = new Vec3(0, 0, 0), client = new EventEmitter();
  let block = testBlock("air", position);
  const bot = Object.assign(new EventEmitter(), { _client: client, blockAt: () => block }) as unknown as Bot;
  const watcher = new ServerBlockObservation(bot, position);
  const expected = (b: typeof block) => b.name === "oak_planks";
  let finished = false;
  const waiting = watcher.wait(new AbortController().signal, 1000, expected).then(() => { finished = true; });
  client.emit("block_change", { location: position, type: 0 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  block = testBlock("oak_planks", position); client.emit("block_change", { location: position, type: 1 });
  await waiting; assert.equal(watcher.matches(expected), true); watcher.dispose();
});
