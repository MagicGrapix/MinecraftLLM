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
import type { SelfState } from "../../../../src/world/types";
import { createDefaultWorldQueryRegistry } from "../../../../src/world/queries/defaultQueries";
import type { WorldQuery } from "../../../../src/world/queries/WorldQuery";
import { WorldQueryRegistry } from "../../../../src/world/queries/WorldQueryRegistry";

const world: WorldQueries = {
  getSelf: () => ({
    position: { x: 1, y: 64, z: 2 },
    health: 20,
    food: 18,
    foodSaturation: 5,
    oxygenLevel: 20,
    onGround: true,
  }),
  getInventory: () => ({ items: [], selectedItem: null }),
  getBlock: () => null,
  findNearestBlocks: () => [],
  getNearbyEntities: () => [],
};

test("default registry executes a valid query and exposes summaries", async () => {
  const registry = createDefaultWorldQueryRegistry(world);

  const result = await registry.execute("get_self", {});

  assert.equal(result.ok, true);
  if (result.ok) assert.equal((result.value as SelfState).health, 20);
  assert.equal(registry.list().length, 5);
  assert.equal(registry.has("find_nearest_blocks"), true);
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
