import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../../../src/execution/Task";
import { SequentialPlanRunner } from "../../../src/execution/SequentialPlanRunner";
import { success, type TaskResult } from "../../../src/execution/TaskResult";
import type { Executor } from "../../../src/execution/Executor";

test("setPlan does not execute and executeNext runs exactly one task", async () => {
  const executor = new ScriptedExecutor();
  executor.enqueue(success({ dug: true }));
  const runner = new SequentialPlanRunner(executor as unknown as Executor);
  const events: string[] = [];
  runner.subscribe((event) => events.push(event.type));

  runner.setPlan([
    { capability: "dig", input: { position: { x: 1, y: 2, z: 3 } } },
    { capability: "place", input: { item: "dirt" } },
  ]);
  assert.equal(executor.started.length, 0);
  assert.equal(runner.remaining().length, 2);
  assert.equal(runner.isExecuting, false);

  const first = await runner.executeNext();
  assert.equal(first?.task.capability, "dig");
  assert.equal(first?.result.ok, true);
  assert.equal(runner.remaining().length, 1);
  assert.equal(runner.isExecuting, false);
  assert.deepEqual(events, ["task_started", "task_finished"]);
});

test("executeNext is single-flight and replaceRemaining never starts a task", async () => {
  const executor = new ScriptedExecutor();
  const deferred = executor.enqueueDeferred();
  const runner = new SequentialPlanRunner(executor as unknown as Executor);
  runner.setPlan([
    { capability: "dig", input: {} },
    { capability: "place", input: {} },
  ]);

  const pending = runner.executeNext();
  await Promise.resolve();
  assert.equal(runner.isExecuting, true);
  await assert.rejects(() => runner.executeNext(), /already executing/);
  runner.replaceRemaining([{ capability: "goto", input: {} }]);
  assert.equal(executor.started.length, 1);

  deferred.resolve(success({ ok: true }));
  await pending;
  assert.equal(runner.remaining()[0]?.capability, "goto");
});

class ScriptedExecutor {
  readonly started: Task[] = [];
  currentTask: Task | null = null;
  private readonly queue: Array<
    TaskResult | DeferredTaskResult
  > = [];

  enqueue(result: TaskResult): void {
    this.queue.push(result);
  }

  enqueueDeferred(): DeferredTaskResult {
    const deferred = new DeferredTaskResult();
    this.queue.push(deferred);
    return deferred;
  }

  abortCurrent(): boolean {
    return true;
  }

  async execute(task: Task): Promise<TaskResult> {
    this.currentTask = task;
    this.started.push(task);
    const next = this.queue.shift();
    const result =
      next instanceof DeferredTaskResult
        ? await next.promise
        : (next ?? success({ ok: true }));
    this.currentTask = null;
    return result;
  }
}

class DeferredTaskResult {
  readonly promise: Promise<TaskResult>;
  private resolvePromise!: (result: TaskResult) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(result: TaskResult): void {
    this.resolvePromise(result);
  }
}
