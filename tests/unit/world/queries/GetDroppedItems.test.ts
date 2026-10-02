import assert from "node:assert/strict";
import test from "node:test";
import type { WorldQueries } from "../../../../src/world/WorldQueries";
import type { DroppedItemInfo, EntityInfo } from "../../../../src/world/types";
import { createDefaultWorldQueryRegistry } from "../../../../src/world/queries/defaultQueries";
import type { QueryResult } from "../../../../src/world/queries/QueryResult";

test("dropped items include only loose entities with a compact shape and exact measurements", async () => {
  const entities = [
    drop(1, "oak_log", 3.30352210163947, 3),
    drop(2, null, 1),
    { ...drop(3, null, 0.5), name: "zombie", type: "mob" },
    drop(4, "coal", 2, 8, "Item"),
    drop(5, "dirt", 4, 2, "item_stack"),
    { ...drop(6, null, 0.25), name: "player", type: "player", username: "owner" },
  ];
  const before = structuredClone(entities);
  const { registry } = setup(() => entities);
  const result = await registry.execute("get_dropped_items", {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const items = result.value as DroppedItemInfo[];
  assert.deepEqual(items, [
    { id: 2, item: null, count: null, position: { x: 1, y: -60, z: 0 }, distance: 1 },
    { id: 4, item: "coal", count: 8, position: { x: 2, y: -60, z: 0 }, distance: 2 },
    { id: 1, item: "oak_log", count: 3, position: { x: 3.30352210163947, y: -60, z: 0 }, distance: 3.30352210163947 },
    { id: 5, item: "dirt", count: 2, position: { x: 4, y: -60, z: 0 }, distance: 4 },
  ]);
  assert.notEqual(items[0]!.position, entities[1]!.position);
  assert.deepEqual(entities, before, "Reading must not mutate cached entities.");
  assert.equal("displayName" in items[0]!, false);
  assert.equal("droppedItem" in items[0]!, false);
});

test("names filter one or multiple exact item names and excludes unknown stacks", async () => {
  const { registry } = setup(() => [
    drop(1, "oak_log", 3, 64), drop(2, "coal", 2), drop(3, null, 1), drop(4, "oak_planks", 4),
  ]);
  assert.deepEqual(ids(await registry.execute("get_dropped_items", { names: " oak_log " })), [1]);
  assert.deepEqual(ids(await registry.execute("get_dropped_items", { names: ["coal", "oak_log"] })), [2, 1]);
  assert.deepEqual(ids(await registry.execute("get_dropped_items", { names: "iron_ingot" })), []);
  const result = await registry.execute("get_dropped_items", { names: "oak_log", count: 1 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal((result.value as DroppedItemInfo[])[0]!.count, 64, "count limits entity results, not the size of their stacks.");
});

test("distance filtering and nearest-first limit are applied after identifying matching drops", async () => {
  const { registry, requests } = setup(() => [
    drop(1, "oak_log", 9), drop(2, "oak_log", 3), drop(3, "oak_log", 5),
    drop(4, "coal", 1), drop(5, "oak_log", 3),
  ]);
  assert.deepEqual(ids(await registry.execute("get_dropped_items", { names: "oak_log", maxDistance: 5, count: 2 })), [2, 5]);
  assert.deepEqual(ids(await registry.execute("get_dropped_items", { names: "oak_log", maxDistance: 5 })), [2, 5, 3]);
  assert.deepEqual(requests, [{ maxDistance: 5 }, { maxDistance: 5 }]);
});

test("default search is 32 blocks with at most 16 nearest item entities", async () => {
  const candidates = Array.from({ length: 20 }, (_, index) => drop(index + 1, "oak_log", index + 1)).reverse();
  const { registry, requests } = setup(() => [drop(100, "oak_log", 33), ...candidates]);
  assert.deepEqual(ids(await registry.execute("get_dropped_items", {})), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.deepEqual(requests, [{ maxDistance: 32 }]);
});

test("dropped item schema rejects invalid or obsolete inputs before observing the world", async () => {
  const { registry, requests } = setup(() => []);
  for (const input of [
    { names: "" }, { names: "  " }, { names: [] }, { names: [""] }, { names: {} },
    { maxDistance: 0 }, { maxDistance: -1 }, { maxDistance: 513 }, { maxDistance: Infinity }, { maxDistance: NaN },
    { count: 0 }, { count: -1 }, { count: 129 }, { count: 1.5 }, { count: Infinity },
    { type: "item" }, { extra: true },
  ]) {
    const result = await registry.execute("get_dropped_items", input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  }
  assert.deepEqual(requests, []);
});

test("schema maximums work and no matching drops are an empty successful observation", async () => {
  const { registry, requests } = setup(() => Array.from({ length: 150 }, (_, index) => drop(index + 1, "coal", index + 1)));
  assert.equal(ids(await registry.execute("get_dropped_items", { maxDistance: 512, count: 128 })).length, 128);
  assert.deepEqual(requests, [{ maxDistance: 512 }]);
  const empty = setup(() => []);
  assert.deepEqual(await empty.registry.execute("get_dropped_items", {}), { ok: true, value: [] });
});

test("fresh calls observe newly received metadata and disappearance without claiming pickup", async () => {
  let entities = [drop(1, null, 1)];
  const { registry } = setup(() => entities);
  const before = await registry.execute("get_dropped_items", {});
  assert.equal(before.ok, true);
  if (before.ok) assert.equal((before.value as DroppedItemInfo[])[0]!.item, null);
  entities = [drop(1, "oak_log", 1, 2)];
  const known = await registry.execute("get_dropped_items", { names: "oak_log" });
  assert.equal(known.ok, true);
  if (known.ok) assert.equal((known.value as DroppedItemInfo[])[0]!.count, 2);
  entities = [];
  assert.deepEqual(await registry.execute("get_dropped_items", {}), { ok: true, value: [] });
});

function drop(id: number, item: string | null, distance: number, count = 1, name = "item"): EntityInfo {
  return {
    id, name, type: "other", username: null, position: { x: distance, y: -60, z: 0 }, distance,
    droppedItem: item === null ? null : { name: item, displayName: item, count },
  };
}

function setup(observe: () => EntityInfo[]) {
  const requests: unknown[] = [];
  const world: WorldQueries = {
    getSelf: () => ({ position: { x: 0, y: -60, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20, onGround: true }),
    getInventory: () => ({ items: [], selectedItem: null }), getBlock: () => null,
    getBlockAccess: () => { throw new Error("Not used."); }, findNearestBlocks: () => [],
    getNearbyEntities: (options) => { requests.push(options); return observe(); },
  };
  return { registry: createDefaultWorldQueryRegistry(world), requests };
}

function ids(result: QueryResult): number[] {
  assert.equal(result.ok, true);
  return result.ok ? (result.value as DroppedItemInfo[]).map((item) => item.id) : [];
}
