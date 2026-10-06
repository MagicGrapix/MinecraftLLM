import assert from "node:assert/strict";
import test from "node:test";
import type { RunningAgentRuntime } from "../../../src/bootstrap/createAgentRuntime";
import { workflowTrialRuntime } from "../../e2e/TrialRuntime";

test("workflow settlement detaches input and awaits producers before physical idle, without disconnecting", async () => {
  const events: string[] = [];
  let finishProducer!: () => void;
  const producer = new Promise<void>(resolve => { finishProducer = resolve; });
  const running = {
    agent: { state: () => ({ mode: "idle" }), task: { steps: [{ status: "done" }, { status: "pending" }] },
      shutdown: async () => { events.push("producer.stop"); await producer; events.push("producer.done"); } },
    chat: { attach: () => events.push("attach"), detach: () => events.push("detach") },
    isPhysicallyIdle: () => true,
    waitForPhysicalIdle: async () => { events.push("physical.idle"); },
    shutdown: async () => { events.push("disconnect"); },
  } as unknown as RunningAgentRuntime;
  const runtime = workflowTrialRuntime(running);
  runtime.attach("Request");
  const settlement = runtime.settle(1000);
  assert.deepEqual(events, ["attach", "detach", "producer.stop"]);
  finishProducer(); await settlement;
  assert.deepEqual(events, ["attach", "detach", "producer.stop", "producer.done", "physical.idle"]);
  assert.deepEqual(runtime.state(), { mode: "idle", planSteps: 2, completedSteps: 1 });
  assert.equal(runtime.isPhysicallyIdle(), true);
  await runtime.shutdown();
  assert.equal(events.at(-1), "disconnect");
});

test("a stuck producer cannot report successful settlement", async () => {
  let readPhysical = false;
  const running = { chat: { detach: () => undefined }, agent: { shutdown: () => new Promise(() => undefined) },
    waitForPhysicalIdle: async () => { readPhysical = true; },
  } as unknown as RunningAgentRuntime;
  await assert.rejects(workflowTrialRuntime(running).settle(10), /Stop agent and settle physical action/);
  assert.equal(readPhysical, false);
});
