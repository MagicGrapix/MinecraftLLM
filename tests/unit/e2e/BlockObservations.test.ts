import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observeBlocks } from "../../e2e/BlockObservations";

test("block observations read only explicit cells and preserve unknown versus air", () => {
  const positions = [{ x: 0, y: -60, z: 1 }, { x: -1, y: -60, z: 1 }, { x: 1, y: -60, z: 1 }];
  const calls: Vec3[] = [];
  const bot = { blockAt: (position: Vec3) => {
    calls.push(position);
    return position.x === 0 ? { name: "oak_planks" } : position.x === -1 ? { name: "air" } : null;
  } } as Pick<Bot, "blockAt">;
  assert.deepEqual(observeBlocks(bot, positions), positions.map((position, i) => ({ position, name: ["oak_planks", "air", null][i] })));
  assert.deepEqual(calls, positions.map((p) => new Vec3(p.x, p.y, p.z)));
  assert.deepEqual(observeBlocks(bot, []), []);
  assert.equal(calls.length, 3);
});

test("scenario cell observations reject unbounded or invalid coordinates", () => {
  const bot = { blockAt: () => { throw new Error("Must not read a cell"); } } as Pick<Bot, "blockAt">;
  assert.throws(() => observeBlocks(bot, Array.from({ length: 65 }, () => ({ x: 0, y: 0, z: 0 }))), /at most 64/);
  for (const x of [0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => observeBlocks(bot, [{ x, y: 0, z: 0 }]), /integer/);
  }
});
