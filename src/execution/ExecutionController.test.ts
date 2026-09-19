import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type {
  Capability,
  ExecutionContext,
} from "../capabilities/Capability";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";
import { ExecutionController, type ExecutionEvent } from "./ExecutionController";
import { Executor } from "./Executor";
import { TaskFactory } from "./TaskFactory";
import { success, type TaskResult } from "./TaskResult";

interface ControlledInput {
  label: string;
}

const emptyWorld: WorldQueries = {
  getSelf: () => ({
    position: { x: 0, y: 0, z: 0 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    onGround: true,
  }),
  getInventory: () => ({ items: [], selectedItem: null }),
  getBlock: () => null,
  findNearestBlocks: () => [],
  getNearbyEntities: () => [],
};

const fakeRuntime = {} as MinecraftRuntime;

test("resume is non-blocking and draining consumes tasks added while active", async () => {
  const { controller, capability } = createHarness();
  controller.enqueue(task("first"));

  const resumed = controller.resume();
  assert.equal(resumed.ok, true);
  assert.deepEqual(capability.started, []);

  await nextTurn();
  assert.deepEqual(capability.started, ["first"]);
  assert.equal(controller.snapshot().current !== null, true);

  const observedDuringExecution = emptyWorld.getSelf();
  assert.equal(observedDuringExecution.health, 20);
  controller.enqueue(task("second"));

  capability.complete("first");
  await nextTurn();
  assert.deepEqual(capability.started, ["first", "second"]);

  capability.complete("second");
  await nextTurn();
  assert.equal(controller.snapshot().current, null);
  assert.equal(controller.snapshot().pending.length, 0);
  assert.equal(controller.snapshot().mode, "draining");
});

test("pause lets the active task finish and preserves the next task", async () => {
  const { controller, capability } = createHarness();
  controller.enqueueMany([task("first"), task("second")]);
  controller.resume();
  await nextTurn();

  controller.pause();
  capability.complete("first");
  await nextTurn();

  const snapshot = controller.snapshot();
  assert.equal(snapshot.mode, "paused");
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.pending.length, 1);
  assert.equal(inputLabel(snapshot.pending[0]), "second");
  assert.deepEqual(capability.started, ["first"]);
});

test("step executes exactly one pending task", async () => {
  const { controller, capability } = createHarness();
  controller.enqueueMany([task("first"), task("second")]);

  const stepped = controller.step();
  assert.equal(stepped.ok, true);
  await nextTurn();
  capability.complete("first");
  await nextTurn();

  const snapshot = controller.snapshot();
  assert.equal(snapshot.mode, "paused");
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.pending.length, 1);
  assert.deepEqual(capability.started, ["first"]);
});

test("replacePending is atomic and never changes the active task", async () => {
  const { controller, capability } = createHarness();
  controller.enqueueMany([task("active"), task("obsolete")]);
  controller.resume();
  await nextTurn();

  const activeId = controller.snapshot().current?.task.id;
  controller.replacePending([task("replacement")]);

  const replaced = controller.snapshot();
  assert.equal(replaced.current?.task.id, activeId);
  assert.deepEqual(replaced.pending.map(inputLabel), ["replacement"]);

  capability.complete("active");
  await nextTurn();
  assert.deepEqual(capability.started, ["active", "replacement"]);
  capability.complete("replacement");
  await nextTurn();
});

test("abortCurrent pauses, returns INTERRUPTED, and preserves pending tasks", async () => {
  const { controller } = createHarness();
  const results: TaskResult[] = [];
  controller.subscribe((event) => {
    if (event.type === "task_finished") results.push(event.result);
  });
  controller.enqueueMany([task("active"), task("pending")]);
  controller.resume();
  await nextTurn();

  const aborted = controller.abortCurrent("Danger detected.");
  assert.equal(aborted.ok, true);
  assert.equal(aborted.snapshot.mode, "paused");
  await nextTurn();

  const snapshot = controller.snapshot();
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.pending.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ok, false);
  if (results[0] && !results[0].ok) {
    assert.equal(results[0].error.code, "INTERRUPTED");
  }
});

test("stale mutations are rejected with REVISION_CONFLICT", () => {
  const { controller } = createHarness();
  const revision = controller.snapshot().revision;

  const first = controller.enqueue(task("first"), {
    expectedRevision: revision,
  });
  assert.equal(first.ok, true);

  const stale = controller.enqueue(task("stale"), {
    expectedRevision: revision,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.code, "REVISION_CONFLICT");
  }
  assert.deepEqual(controller.snapshot().pending.map(inputLabel), ["first"]);
});

test("events are deterministic and a throwing listener cannot break execution", async () => {
  const { controller, capability } = createHarness();
  const eventTypes: ExecutionEvent["type"][] = [];
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    controller.subscribe(() => {
      throw new Error("listener failure");
    });
    controller.subscribe((event) => eventTypes.push(event.type));

    controller.enqueue(task("only"));
    controller.resume();
    await nextTurn();
    capability.complete("only");
    await nextTurn();

    assert.deepEqual(eventTypes, [
      "queue_changed",
      "mode_changed",
      "task_started",
      "task_finished",
      "queue_idle",
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("queue mutations support prepend, remove, and clear", () => {
  const { controller } = createHarness();
  const enqueued = controller.enqueueMany([task("second"), task("third")]);
  assert.equal(enqueued.ok, true);
  controller.prepend(task("first"));

  const before = controller.snapshot();
  assert.deepEqual(before.pending.map(inputLabel), [
    "first",
    "second",
    "third",
  ]);

  const secondId = before.pending[1]?.id;
  assert.ok(secondId);
  controller.removePending(secondId);
  assert.deepEqual(controller.snapshot().pending.map(inputLabel), [
    "first",
    "third",
  ]);

  controller.clearPending();
  assert.equal(controller.snapshot().pending.length, 0);
});

test("shutdown aborts the active task, clears pending work, and closes control", async () => {
  const { controller } = createHarness();
  controller.enqueueMany([task("active"), task("pending")]);
  controller.resume();
  await nextTurn();

  await controller.shutdown("Test shutdown.");

  const snapshot = controller.snapshot();
  assert.equal(snapshot.shutdown, true);
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.pending.length, 0);
  const rejected = controller.enqueue(task("late"));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "SHUTDOWN");
});

class ControlledCapability
  implements Capability<ControlledInput, { label: string }>
{
  readonly name = "controlled";
  readonly inputSchema: z.ZodType<ControlledInput> = z
    .object({ label: z.string() })
    .strict();
  readonly started: string[] = [];
  private readonly completions = new Map<
    string,
    (result: TaskResult<{ label: string }>) => void
  >();

  execute(
    input: ControlledInput,
    _context: ExecutionContext,
  ): Promise<TaskResult<{ label: string }>> {
    this.started.push(input.label);
    return new Promise((resolve) => {
      this.completions.set(input.label, resolve);
    });
  }

  complete(label: string): void {
    const resolve = this.completions.get(label);
    assert.ok(resolve, `No active execution named "${label}".`);
    this.completions.delete(label);
    resolve(success({ label }));
  }
}

function createHarness(): {
  controller: ExecutionController;
  capability: ControlledCapability;
} {
  const capability = new ControlledCapability();
  const registry = new CapabilityRegistry();
  registry.register(capability);
  const executor = new Executor({
    registry,
    runtime: fakeRuntime,
    world: emptyWorld,
    defaultTimeoutMs: 10_000,
  });
  let id = 0;
  const taskFactory = new TaskFactory(
    () => `task-${++id}`,
    () => id,
  );

  return {
    capability,
    controller: new ExecutionController({ executor, taskFactory }),
  };
}

function task(label: string) {
  return { capability: "controlled", input: { label } };
}

function inputLabel(taskValue: { input: unknown } | undefined): string {
  assert.ok(taskValue);
  return (taskValue.input as ControlledInput).label;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
