import assert from "node:assert/strict";
import test from "node:test";
import { CollectionOperationsStore } from "../../../src/debug/CollectionOperationsStore";

test("collection child pagination retains parent identity, outcomes, bounds and finished details", () => {
  const store = new CollectionOperationsStore(2, 3);
  store.record("action.task_started", { taskId: "task", actionNumber: 42, toolCallId: "native", capability: "collect_resource" });
  for (let index = 1; index <= 5; index++) {
    store.record("collect.event", { taskId: "task", index, event: "operation_started", operation: "dig", args: { x: index } });
    store.record("collect.event", { taskId: "task", index, event: "operation_finished", result: { ok: index !== 4 }, durationMs: 100 });
  }
  const page = store.page(42, 0, 2)!;
  assert.equal(page.toolCallId, "native"); assert.equal(page.dropped, 2);
  assert.deepEqual(page.operations.map(o => [o.index, o.status]), [[3, "completed"], [4, "failed"]]);
  assert.equal(page.nextAfter, 4);
  assert.deepEqual(store.page(42, 4)!.operations.map(o => o.index), [5]);
  page.operations[0]!.status = "failed";
  assert.equal(store.page(42)!.operations[0]!.status, "completed", "Read snapshots cannot mutate retention");
  assert.throws(() => store.page(42, -1)); assert.throws(() => store.page(42, 0, 1000));
  store.record("collect.event", { taskId: "other", index: 1, event: "operation_started", operation: "dig" });
  assert.equal(store.page(99), null);
  store.clear(); assert.equal(store.page(42), null);
});

test("interruptions remain visible; unrelated traces and evicted runs cannot grow the store", () => {
  const store = new CollectionOperationsStore(1, 2);
  for (const [taskId, actionNumber] of [["old", 1], ["new", 2]] as const) {
    store.record("action.task_started", { taskId, actionNumber, capability: "collect_resource" });
    store.record("collect.event", { taskId, index: 1, event: "operation_started", operation: "goto_source" });
    store.record("collect.event", { taskId, index: 1, event: "operation_failed", error: "stop", durationMs: 8 });
  }
  assert.equal(store.page(1), null);
  assert.equal(store.page(2)!.operations[0]!.error, "stop");
  assert.equal(store.page(2)!.operations[0]!.status, "failed");
});
