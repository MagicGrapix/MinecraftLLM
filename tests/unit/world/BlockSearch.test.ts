import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { findBlocksCooperatively } from "../../../src/world/BlockSearch";

test("cooperative search returns nearest matching cells, including across negative chunks", async () => {
  const positions = [new Vec3(-17, -60, 0), new Vec3(2, -60, 0), new Vec3(50, -60, 0)];
  const bot = {
    entity: { position: new Vec3(-0.5, -60, 0) }, game: { dimension: "overworld", minY: -64, height: 384 },
    world: { getColumn: () => ({}) },
    blockAt: (p: Vec3) => positions.some((v) => v.equals(p)) ? { position: p, type: 1 } : null,
  } as unknown as Bot;
  const blocks = await findBlocksCooperatively(bot, new Set([1]), { count: 2, maxDistance: 50 });
  assert.deepEqual(blocks.map((block) => block.position), [positions[1], positions[0]]);
  await assert.rejects(findBlocksCooperatively(bot, new Set([1]), { maxDistance: 51 }), /radius/);
});

test("large searches yield to stop events instead of blocking until all cells are visited", async () => {
  const abort = new AbortController();
  let reads = 0;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: "overworld" },
    world: { getColumn: () => ({}) }, blockAt: () => { reads++; return null; },
  } as unknown as Bot;
  setImmediate(() => abort.abort(new Error("stop search")));
  await assert.rejects(findBlocksCooperatively(bot, new Set([1]), { maxDistance: 50, signal: abort.signal }), /stop search/);
  assert.ok(reads > 0 && reads < 5000);
});

test("internal collection search stays anchored and excludes attempted cells before limiting results", async () => {
  const bot = {
    entity: { position: new Vec3(40, 0, 0) }, game: { dimension: "overworld", minY: 0, height: 16 },
    world: { getColumn: () => ({}) },
    blockAt: (p: Vec3) => [1, 2, 41].includes(p.x) && p.y === 0 && p.z === 0 ? { position: p, type: 1 } : null,
  } as unknown as Bot;
  const found = await findBlocksCooperatively(bot, new Set([1]), { origin: { x: 0, y: 0, z: 0 }, maxDistance: 4, count: 1, exclude: new Set(["1,0,0"]) });
  assert.deepEqual(found.map(b => b.position.x), [2]);
});
