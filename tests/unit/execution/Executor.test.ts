import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type {
  Capability,
  ExecutionContext,
} from "../../../src/capabilities/Capability";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { Executor } from "../../../src/execution/Executor";
import type { TaskSpec } from "../../../src/execution/Task";
import { TaskFactory } from "../../../src/execution/TaskFactory";
import { success, type TaskResult } from "../../../src/execution/TaskResult";

const emptyWorld: WorldQueries = {
  isKnownName: () => true,
  getSelf: () => ({
    position: { x: 0, y: 0, z: 0 },
    facing: "north",
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    onGround: true,
  }),
  getInventory: () => ({ items: [], selectedItem: null }),
  getBlock: () => null,
  getBlockAccess: () => { throw new Error("Block access was not stubbed."); },
  findNearestBlocks: () => [],
  getNearbyEntities: () => [],
};

const fakeRuntime = {} as MinecraftRuntime;
const taskFactory = new TaskFactory();

test("waitForIdle observes the physical lock after cancellation returns", async () => {
  let release!: () => void;
  const operation = new Promise<void>((resolve) => { release = resolve; });
  const capability: Capability<Record<string, never>, {}> = {
    name: "settling", inputSchema: z.object({}).strict(),
    execute: async () => { await operation; return success({}); },
  };
  const registry = new CapabilityRegistry(); registry.register(capability);
  const executor = new Executor({ registry, runtime: fakeRuntime, world: emptyWorld, cancellationGraceMs: 0 });
  const running = executor.execute(taskFactory.create({ capability: "settling", input: {} }));
  executor.abortCurrent();
  await running;
  await assert.rejects(executor.waitForIdle(0), /did not settle/);
  release();
  await executor.waitForIdle(100);
  assert.equal(executor.currentTask, null);
});

test("execute returns a successful TaskResult and releases currentTask", async () => {
  const capability: Capability<Record<string, never>, { done: true }> = {
    name: "success",
    inputSchema: z.object({}).strict(),
    execute: async () => success({ done: true }),
  };
  const executor = createExecutor(capability);
  const task = taskFactory.create({ capability: "success", input: {} });

  const result = await executor.execute(task);

  assert.deepEqual(result, { ok: true, value: { done: true } });
  assert.equal(executor.currentTask, null);
});

test("invalid capability input returns INVALID_ARGUMENT without executing", async () => {
  let executed = false;
  const capability: Capability<{ value: string }, { accepted: true }> = {
    name: "validated",
    inputSchema: z.object({ value: z.string() }).strict(),
    execute: async () => {
      executed = true;
      return success({ accepted: true });
    },
  };

  const result = await executeOne(capability, {
    capability: "validated",
    input: { value: 42 },
  });

  assert.equal(executed, false);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("a task exceeding its deadline returns TIMEOUT", async () => {
  const result = await executeOne(
    neverEndingCapability("slow"),
    { capability: "slow", input: {} },
    10,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TIMEOUT");
});

test("abortCurrent returns INTERRUPTED instead of INTERNAL_ERROR", async () => {
  const executor = createExecutor(neverEndingCapability("interruptible"));
  const task = taskFactory.create({
    capability: "interruptible",
    input: {},
  });

  const running = executor.execute(task);
  assert.equal(executor.currentTask?.id, task.id);
  assert.equal(executor.abortCurrent("Emergency behavior."), true);
  const result = await running;

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INTERRUPTED");
    assert.equal(result.error.message, "Emergency behavior.");
  }
});

test("abortCurrent waits for a registered physical operation to settle", async () => {
  let releaseOperation!: () => void;
  const physicalOperation = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const capability: Capability<Record<string, never>, { done: true }> = {
    name: "barrier",
    inputSchema: z.object({}).strict(),
    execute: async (_input, context) => {
      context.deferCancellationUntil(physicalOperation);
      await physicalOperation;
      context.signal.throwIfAborted();
      return success({ done: true });
    },
  };
  const executor = createExecutor(capability);
  const task = taskFactory.create({ capability: "barrier", input: {} });

  let settled = false;
  const running = executor.execute(task).finally(() => {
    settled = true;
  });
  assert.equal(executor.abortCurrent("Stop after the physical operation."), true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(executor.currentTask?.id, task.id);

  releaseOperation();
  const result = await running;

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INTERRUPTED");
  assert.equal(executor.currentTask, null);
});

test("an unexpected capability exception returns INTERNAL_ERROR", async () => {
  const capability: Capability<Record<string, never>, never> = {
    name: "crash",
    inputSchema: z.object({}).strict(),
    execute: async () => {
      throw new Error("unexpected");
    },
  };

  const result = await executeOne(capability, {
    capability: "crash",
    input: {},
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INTERNAL_ERROR");
    assert.equal(result.error.message, "unexpected");
  }
});

test("a second physical execution is refused with BLOCKED", async () => {
  const executor = createExecutor(neverEndingCapability("physical"));
  const first = taskFactory.create({ capability: "physical", input: {} });
  const second = taskFactory.create({ capability: "physical", input: {} });

  const firstExecution = executor.execute(first);
  const secondResult = await executor.execute(second);

  assert.equal(secondResult.ok, false);
  if (!secondResult.ok) {
    assert.equal(secondResult.error.code, "BLOCKED");
    assert.equal(secondResult.error.facts?.currentTaskId, first.id);
    assert.equal(secondResult.error.facts?.requestedTaskId, second.id);
  }

  executor.abortCurrent("Test cleanup.");
  await firstExecution;
});

function neverEndingCapability(
  name: string,
): Capability<Record<string, never>, never> {
  return {
    name,
    inputSchema: z.object({}).strict(),
    execute: async (
      _input: Record<string, never>,
      _context: ExecutionContext,
    ): Promise<TaskResult<never>> =>
      new Promise<TaskResult<never>>(() => undefined),
  };
}

test("a timed-out uncooperative capability retains its physical lock until late completion", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const executor = createExecutor({
    name: "late", inputSchema: z.object({}).strict(),
    execute: async () => { calls++; await pending; return success(null); },
  }, 5);
  const first = taskFactory.create({ capability: "late", input: {} });
  const result = await executor.execute(first);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "TIMEOUT");
    assert.equal(result.error.facts?.stillSettling, true);
  }
  assert.equal(executor.currentTask?.id, first.id);
  const blocked = await executor.execute(taskFactory.create({ capability: "late", input: {} }));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, "BLOCKED");
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.currentTask, null);
  assert.equal((await executor.execute(taskFactory.create({ capability: "late", input: {} }))).ok, true);
});

test("registered work remains deadline-bound even if the capability already returned", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const executor = createExecutor({
    name: "early", inputSchema: z.object({}).strict(),
    execute: async (_input, context) => { context.deferCancellationUntil(pending); return success(null); },
  }, 5);
  const result = await executor.execute(taskFactory.create({ capability: "early", input: {} }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TIMEOUT");
  assert.ok(executor.currentTask);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.currentTask, null);
});

function createExecutor<Input, Output>(
  capability: Capability<Input, Output>,
  defaultTimeoutMs = 1_000,
): Executor {
  const registry = new CapabilityRegistry();
  registry.register(capability);
  return new Executor({
    registry,
    runtime: fakeRuntime,
    world: emptyWorld,
    defaultTimeoutMs,
    cancellationGraceMs: 10,
  });
}

async function executeOne<Input, Output>(
  capability: Capability<Input, Output>,
  spec: TaskSpec,
  defaultTimeoutMs = 1_000,
): Promise<TaskResult> {
  const executor = createExecutor(capability, defaultTimeoutMs);
  return executor.execute(taskFactory.create(spec));
}
