import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { terrainFixture } from "../../support/collectionTerrain";
import { rememberBuildSite, isKnownBuildCell } from "../../../src/runtime/KnownBuildSites";
import { ResourceCollector } from "../../../src/collection/ResourceCollector";
import { TestCollectionOperations, oakResource } from "../../support/collection";
import { failure } from "../../../src/execution/TaskResult";
import type { Movements } from "mineflayer-pathfinder";

test("access excludes source, supporting floor, stations, known buildings, liquids and unknown ground", () => {
  const f = terrainFixture(), p = new Vec3(2, 0, 0), target = new Vec3(3, 3, 0);
  f.set(p, "dirt"); assert.equal(f.terrain.canBreak(f.read(p)!, target), true);
  assert.equal(f.terrain.canBreak(f.read(p)!, p), false);
  assert.equal(f.terrain.canBreak(f.read(p.offset(0, -1, 0))!, target), false);
  f.set(p.offset(1, 0, 0), "water"); assert.equal(f.terrain.canBreak(f.read(p)!, target), false);
  f.set(p.offset(1, 0, 0), "air"); f.set(p, "chest"); assert.equal(f.terrain.protected(p), true);
  f.set(p, "dirt"); rememberBuildSite(f.context.runtime, "overworld", p, 3, 3, 3);
  assert.equal(f.terrain.canBreak(f.read(p)!, target), false);
  assert.equal(isKnownBuildCell(f.context.runtime, "nether", p), false);
  const other = new Vec3(-3, 0, 0); f.cells.set(other.offset(0, -1, 0).toString(), null);
  assert.equal(f.terrain.canPlace(other), false);
  f.terrain.dispose();
});

test("walking bounds apply to feet, not head-clearance cells, so a three-block climb remains plannable", () => {
  const f = terrainFixture();
  const movements = { blocksToAvoid: new Set(), exclusionAreasStep: [], getNeighbors: () => [new Vec3(2, 3, 0), new Vec3(2, 4, 0)] } as unknown as Movements;
  f.terrain.configureWalking(movements, { x: 0, y: 0, z: 0 });
  assert.deepEqual(movements.getNeighbors({} as never).map(p => p.y), [3]);
  assert.equal(movements.exclusionAreasStep.length, 0);
  f.terrain.dispose();
});

test("scaffolds need unreserved dirt, a bounded height and a placement budget", async () => {
  const f = terrainFixture();
  assert.equal(f.terrain.canPlace(new Vec3(0, 0, 0)), false, "Never plan a scaffold inside the bot's body");
  await assert.rejects(f.place(new Vec3(2, 0, 0), 8), /reserved/);
  assert.equal(f.terrain.left, 0);
  const high = new Vec3(2, 4, 0); f.set(high.offset(0, -1, 0), "dirt");
  await assert.rejects(f.place(high), /height/);
  for (let i = 0; i < 24; i++) await f.place(new Vec3(i + 2, 0, 0));
  assert.equal(f.terrain.left, 24);
  assert.equal(f.bot._client.listenerCount("block_change"), 1, "All scaffold observations share a single packet listener");
  assert.equal(f.terrain.canPlace(new Vec3(26, 0, 0)), false);
  assert.equal(f.events.filter(e => e.event === "operation_started").length, 26);
  f.terrain.dispose(); assert.equal(f.bot._client.listenerCount("block_change"), 0);
});

test("scaffold placement dispatches during the jump without waiting for inventory resynchronization", async () => {
  const f = terrainFixture();
  f.stock(0);
  await assert.rejects(f.place(new Vec3(2, 0, 0)), /reserved/);
  assert.equal(f.terrain.left, 0);
  f.stock(8);
  let dispatched = false;
  const promise = f.place(new Vec3(2, 0, 0), 0, async () => { dispatched = true; f.set(new Vec3(2, 0, 0), "dirt"); });
  assert.equal(dispatched, true);
  await promise; f.terrain.dispose();
});

test("unreachable cleanup leaves dirt and moderate ground excludes cliffs but accepts hills and shallow hollows", async () => {
  const f = terrainFixture(), p = new Vec3(2, 0, 0);
  await f.place(p);
  f.context.world.getBlockAccess = (() => ({ canDig: false })) as unknown as typeof f.context.world.getBlockAccess;
  const result = await f.terrain.cleanup(f.controller.signal);
  assert.ok(!result.ok); assert.equal(f.terrain.left, 1); assert.equal(f.digs(), 0);
  const hollow = new Vec3(4, -2, 0); f.set(hollow, "air");
  assert.equal(f.terrain.canPlace(hollow), true);
  const hill = new Vec3(5, 2, 0); f.set(hill.offset(0, -1, 0), "dirt");
  assert.equal(f.terrain.canPlace(hill), true);
  const cliff = new Vec3(6, 0, 0);
  for (let y = -1; y >= -4; y--) f.set(new Vec3(6, y, 0), "air");
  assert.equal(f.terrain.canPlace(cliff), false);
  f.terrain.dispose();
});

test("server-confirmed temporary dirt is removed safely; changed-away-and-back dirt is never claimed", async () => {
  const f = terrainFixture(), p = new Vec3(2, 0, 0), q = new Vec3(3, 0, 0);
  await f.place(p); await f.place(q);
  f.set(q, "stone"); f.set(q, "dirt");
  const result = await f.terrain.cleanup(f.controller.signal);
  assert.ok(!result.ok); assert.equal(f.terrain.left, 1);
  assert.equal(f.read(p)!.name, "air"); assert.equal(f.read(q)!.name, "dirt"); assert.equal(f.digs(), 1);
  f.terrain.dispose();
});

test("stopping during a placement leaves an unconfirmed entry and cleanup does no physical work", async () => {
  const f = terrainFixture(), p = new Vec3(2, 0, 0);
  await assert.rejects(f.place(p, 0, async () => { f.set(p, "dirt", false); f.controller.abort(new Error("stop")); }), /stop/);
  assert.equal(f.terrain.left, 1); assert.equal(f.terrain.scaffolds.values().next().value!.owned, false);
  await assert.rejects(f.terrain.cleanup(f.controller.signal), /stop/); assert.equal(f.digs(), 0);
  f.terrain.dispose();
});

test("cleanup failure does not mask collected items and stays in the compact report", async () => {
  const ops = Object.assign(new TestCollectionOperations(), {
    scaffoldsLeft: () => 2,
    cleanup: async () => failure("NO_PATH", "Return blocked"),
  });
  const result = await new ResourceCollector(ops).collect(oakResource, 4, { signal: new AbortController().signal });
  assert.ok(result.ok); assert.equal(result.value.collected, 4); assert.equal(result.value.scaffoldsLeft, 2);
  assert.ok(JSON.stringify(result).length < 1000);
});

test("stop does not start cleanup after the collector has been interrupted", async () => {
  const abort = new AbortController(); let cleaned = 0;
  const ops = Object.assign(new TestCollectionOperations(), { scaffoldsLeft: () => 1, cleanup: async () => { cleaned++; return failure("BLOCKED", "No cleanup"); } });
  ops.onDig = async () => { abort.abort(new Error("stop")); throw abort.signal.reason; };
  await assert.rejects(new ResourceCollector(ops).collect(oakResource, 4, { signal: abort.signal }), /stop/);
  assert.equal(cleaned, 0);
});
