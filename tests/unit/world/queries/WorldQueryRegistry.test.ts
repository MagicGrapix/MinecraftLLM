import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { Capability } from "../../../../src/capabilities/Capability";
import { CapabilityRegistry } from "../../../../src/capabilities/CapabilityRegistry";
import { Executor } from "../../../../src/execution/Executor";
import { TaskFactory } from "../../../../src/execution/TaskFactory";
import type { TaskResult } from "../../../../src/execution/TaskResult";
import type { MinecraftRuntime } from "../../../../src/runtime/MinecraftRuntime";
import type { WorldQueries } from "../../../../src/world/WorldQueries";
import type { BlockAccessInfo } from "../../../../src/world/BlockAccess";
import type { SelfState } from "../../../../src/world/types";
import { createDefaultWorldQueryRegistry } from "../../../../src/world/queries/defaultQueries";
import type { WorldQuery } from "../../../../src/world/queries/WorldQuery";
import { WorldQueryRegistry } from "../../../../src/world/queries/WorldQueryRegistry";

const world: WorldQueries = {
  isKnownName: () => true,
  getSelf: () => ({
    position: { x: 1, y: 64, z: 2 },
    facing: "north",
    health: 20,
    food: 18,
    foodSaturation: 5,
    oxygenLevel: 20,
    onGround: true,
  }),
  getInventory: () => ({ items: [], selectedItem: null }),
  getBlock: () => null,
  getBlockAccess: () => { throw new Error("Block access was not stubbed."); },
  findNearestBlocks: async () => [],
  getNearbyEntities: () => [],
};

test("default registry executes a valid query and exposes summaries", async () => {
  const registry = createDefaultWorldQueryRegistry(world);

  const result = await registry.execute("get_self", {});

  assert.equal(result.ok, true);
  if (result.ok) assert.equal((result.value as SelfState).health, 20);
  assert.equal(registry.list().length, 7);
  assert.equal(registry.has("find_nearest_blocks"), true);
  assert.equal(registry.has("get_dropped_items"), true);
  assert.equal(registry.has("get_nearby_entities"), false);
  assert.equal((await registry.execute("get_nearby_entities", {})).ok, false);
});

test("all callers share query radius, output and cancellation limits", async () => {
  const defaults = createDefaultWorldQueryRegistry(world);
  const tooFar = await defaults.execute("find_nearest_blocks", { names: ["oak_log"], maxDistance: 51 });
  assert.equal(tooFar.ok, false);
  if (!tooFar.ok) assert.equal(tooFar.error.code, "INVALID_ARGUMENT");
  const registry = new WorldQueryRegistry(world);
  registry.register({ name: "large", description: "large", inputSchema: z.object({}), execute: async () => ({ ok: true, value: "x".repeat(13_000) }) });
  const large = await registry.execute("large", {});
  if (large.ok) assert.fail("Unbounded query result");
  assert.equal(large.error.code, "RESULT_TOO_LARGE");
  let started = false;
  registry.register({ name: "pending", description: "pending", inputSchema: z.object({}), execute: async () => { started = true; return new Promise(() => undefined); } });
  const abort = new AbortController();
  const pending = registry.execute("pending", {}, abort.signal);
  abort.abort();
  const stopped = await pending;
  assert.equal(started, true);
  if (stopped.ok) assert.fail("Aborted query succeeded");
  assert.equal(stopped.error.code, "INTERRUPTED");
});

test("unknown and invalid queries return structured errors", async () => {
  const registry = createDefaultWorldQueryRegistry(world);

  const unknown = await registry.execute("missing", {});
  const invalid = await registry.execute("get_block", {
    position: { x: 1.5, y: 64, z: 2 },
  });

  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "QUERY_NOT_FOUND");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_ARGUMENT");
});

test("get_block_access delegates strict integer coordinates to the world adapter", async () => {
  const position = { x: 7, y: -59, z: 4 };
  const expected: BlockAccessInfo = {
    position, loaded: true, block: "oak_log", distanceFromEyes: Math.PI,
    reach: 5, withinReach: true, visible: false, canDig: false,
    reason: "occluded", blocker: { block: "oak_leaves", position: { x: 8, y: -59, z: 4 } },
  };
  const observed: unknown[] = [];
  const registry = createDefaultWorldQueryRegistry({
    ...world,
    getBlockAccess: (input) => { observed.push(input); return expected; },
  });
  assert.equal(registry.has("get_block_access"), true);
  assert.deepEqual(await registry.execute("get_block_access", { position }), { ok: true, value: expected });
  assert.deepEqual(observed, [position]);

  for (const input of [
    {}, { position: JSON.stringify(position) },
    { position: { ...position, x: 7.5 } }, { position: { ...position, x: Infinity } },
    { position: { ...position, dimension: "overworld" } }, { position, move: true },
  ]) {
    const result = await registry.execute("get_block_access", input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  }
  assert.equal(observed.length, 1, "Invalid inputs must not execute the query.");
});

test("searches reject strings, compound names and unknown IDs rather than returning empty results", async () => {
  const searches: string[] = [];
  const registry = createDefaultWorldQueryRegistry({ ...world,
    isKnownName: (_kind, name) => ["oak_log", "birch_log", "minecraft:oak_log"].includes(name),
    findNearestBlocks: async () => { searches.push("blocks"); return []; },
    getNearbyEntities: () => { searches.push("drops"); return []; },
  });
  for (const query of ["find_nearest_blocks", "get_dropped_items"]) {
    for (const names of ["oak_log", "oak_log,log,oak_planks", ["oak_log,log"], ["log"], ["oak_log", "invented_wood"]]) {
      const result = await registry.execute(query, { names });
      assert.equal(result.ok, false, JSON.stringify({ query, names }));
      if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
    }
    const invalid = await registry.execute(query, { names: ["log"] });
    if (!invalid.ok) assert.match(invalid.error.message, /Unknown.*log.*No search was performed/);
  }
  assert.deepEqual(searches, []);
  for (const query of ["find_nearest_blocks", "get_dropped_items"]) {
    assert.deepEqual(await registry.execute(query, { names: ["oak_log"] }), { ok: true, value: [] });
  }
  assert.deepEqual(searches, ["blocks", "drops"]);
});

test("unexpected query exceptions become INTERNAL_ERROR", async () => {
  const registry = new WorldQueryRegistry(world);
  const crashingQuery: WorldQuery<Record<string, never>, never> = {
    name: "crash",
    description: "Crash for testing.",
    inputSchema: z.object({}).strict(),
    execute: async () => {
      throw new Error("query exploded");
    },
  };
  registry.register(crashingQuery);

  const result = await registry.execute("crash", {});

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INTERNAL_ERROR");
    assert.equal(result.error.message, "query exploded");
  }
});

test("a world query can complete while a physical task is active", async () => {
  const capability: Capability<Record<string, never>, never> = {
    name: "slow",
    inputSchema: z.object({}).strict(),
    execute: async (): Promise<TaskResult<never>> =>
      new Promise<TaskResult<never>>(() => undefined),
  };
  const capabilities = new CapabilityRegistry();
  capabilities.register(capability);
  const executor = new Executor({
    registry: capabilities,
    runtime: {} as MinecraftRuntime,
    world,
    defaultTimeoutMs: 10_000,
  });
  const execution = executor.execute(
    new TaskFactory().create({ capability: "slow", input: {} }),
  );
  const queries = createDefaultWorldQueryRegistry(world);

  const queryResult = await queries.execute("get_self", {});

  assert.equal(executor.currentTask !== null, true);
  assert.equal(queryResult.ok, true);
  executor.abortCurrent("Test cleanup.");
  await execution;
});
