import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { ActionAgent } from "../../../src/agent/ActionAgent";
import { ActionContextBuilder } from "../../../src/agent/ActionContextBuilder";
import { actionReportForContext } from "../../../src/agent/ActionReportFormatter";
import type { ActionDelegation, ActionTaskOutcome } from "../../../src/agent/ActionTypes";
import { AgentToolBridge } from "../../../src/agent/AgentToolBridge";
import { WorkflowAgent } from "../../../src/agent/WorkflowAgent";
import type { WorkflowSummaryFile } from "../../../src/agent/WorkflowState";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { ACTION_MAX_TOOL_CALLS } from "../../../src/config";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { Executor } from "../../../src/execution/Executor";
import type { Task, TaskSpec } from "../../../src/execution/Task";
import { failure, success, type TaskResult } from "../../../src/execution/TaskResult";
import { FakeLLMClient } from "../../../src/llm/FakeLLMClient";
import type { LLMMessage, LLMResponse } from "../../../src/llm/LLMClient";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { loadWorkflowPrompts } from "../../../src/prompts/WorkflowPrompts";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { SkillLoader } from "../../../src/skills/SkillLoader";
import type { SkillRegistry } from "../../../src/skills/SkillRegistry";
import { BlockPositionSchema } from "../../../src/shared/types";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";

test("delegation uses one actioner prompt and explicit private handoff without intent or memory calls", async () => {
  const h = await harness();
  call(h.llm, "finish_step", { status: "needs_user", message: "No target supplied." });
  const report = await h.agent.runDelegatedStep(delegation(), { generationId: 42, delegation: 2 });
  assert.deepEqual(report, { status: "needs_user", message: "No target supplied.", outcomes: [] });
  assert.equal(h.agent.state().mode, "idle");
  const request = h.llm.requests[0]!;
  assert.equal(request.trace?.phase, "actioner");
  assert.equal(request.trace?.generationId, 42);
  assert.equal(request.trace?.reflection, 2);
  assert.deepEqual(request.messages.map((m) => m.role), ["system", "assistant", "user"]);
  assert.equal(request.messages[2]!.content, delegation().instruction);
  assert.equal(h.llm.requests.length, 1);
  assert.deepEqual(h.retries, []);
  assert.equal(ACTION_MAX_TOOL_CALLS, 256);
});

test("queries and direct actions share one conversation; operational notes survive a changed approach", async () => {
  const h = await harness();
  call(h.llm, "get_inventory", {});
  action(h.llm, "goto", 1, "Approach the observed log, then inspect access.");
  h.executor.enqueue(failure("NO_PATH", "Route blocked.", { facts: { reason: "no_scaffolding", distance: 8.123456 } }));
  call(h.llm, "get_self", {}, "The route failed; inspect before choosing another target.");
  action(h.llm, "dig", 2, "Use the newly observed reachable block instead.");
  h.executor.enqueue(success({ block: "oak_log", position: { x: 2, y: -60, z: 0 } }));
  call(h.llm, "get_inventory", {});
  call(h.llm, "finish_step", { status: "success", message: "Observed block removed; inventory verified." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.deepEqual(h.executor.started.map((t) => [t.capability, (t.input as { position: { x: number } }).position.x]), [["goto", 1], ["dig", 2]]);
  assert.equal(report.outcomes.length, 2);
  for (const request of h.llm.requests) {
    assert.equal(request.trace?.phase, "actioner");
    assert.deepEqual(request.tools, h.llm.requests[0]!.tools);
    assert.equal(request.messages[2]!.content, delegation().instruction);
    assert.doesNotMatch(request.messages[0]!.content!, /## Local Plan|Pending actions|## Available Capabilities/);
    protocolValid(request.messages);
  }
  assert.match(JSON.stringify(h.llm.requests[3]!.messages), /Approach the observed log/);
  assert.match(h.llm.requests[2]!.messages[0]!.content!, /NO_PATH/);
  assert.match(JSON.stringify(h.llm.requests[5]!.messages), /Use the newly observed reachable block/);
  const result = JSON.parse(h.llm.requests[2]!.messages.at(-1)!.content!);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NO_PATH");
  assert.equal(result.task, undefined);
  const rows = h.inspector.listRounds().map((r) => h.inspector.getRound(r.id)!);
  const failed = rows.find((r) => r.toolExecutions.some((e) => e.name === "goto" && e.ok === false))!;
  assert.equal(failed.failed, true);
  assert.equal(failed.agentLabel, "Actioner");
  assert.equal(failed.stepLabel, "Step 1 — Collect a log");
});

test("a direct capability is awaited before any next LLM call", async () => {
  const h = await harness();
  action(h.llm, "dig", 1, "Dig the observed block.");
  const physical = h.executor.enqueueDeferred();
  h.llm.enqueue((request) => {
    assert.equal(h.executor.currentTask, null);
    assert.equal(h.executor.started.length, 1);
    assert.deepEqual(JSON.parse(request.messages.at(-1)!.content!), { ok: true, value: { block: "oak_log" } });
    return response("finish_step", { status: "needs_user", message: "Block broken, pickup not verified." });
  });
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => h.agent.state().mode === "executing");
  assert.equal(h.llm.requests.length, 1);
  assert.equal("remainingTasks" in h.agent.state().run!, false);
  assert.equal("localPlan" in h.agent.state().run!, false);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.llm.requests.length, 1);
  physical.resolve(success({ block: "oak_log" }));
  assert.equal((await pending).outcomes.length, 1);
  assert.equal(h.llm.maxConcurrentRequests, 1);
});

test("native capabilities execute through the real Executor and refresh observations before the next LLM call", async () => {
  let executed = 0;
  let observerFinished = false;
  const h = await harness({
    execute: async (_name, _input, context) => {
      context.signal.throwIfAborted();
      executed += 1;
      return success({ block: "oak_log" });
    },
    onTaskFinished: async () => {
      await new Promise((r) => setTimeout(r, 5));
      h.world.getInventory = () => ({ items: [{ name: "oak_log", displayName: "Oak Log", type: 1, metadata: 0, count: 2, slot: 36 }], selectedItem: null });
      observerFinished = true;
    },
  });
  action(h.llm, "dig", 1);
  h.llm.enqueue((request) => {
    assert.equal(executed, 1);
    assert.equal(observerFinished, true);
    assert.equal(h.physicalExecutor.currentTask, null);
    assert.match(request.messages[0]!.content!, /Bot inventory: oak_log x2/);
    return response("finish_step", { status: "success", message: "Result checked." });
  });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.outcomes[0]!.task.capability, "dig");
  assert.equal(report.outcomes[0]!.result.ok, true);
});

test("bounded history keeps notes, pins the instruction, evicts whole exchanges and resets after handoff", async () => {
  for (const mode of ["native", "compact"] as const) {
    const h = await harness({ toolReplayMode: mode });
    for (let i = 0; i < 14; i++) {
      action(h.llm, "dig", i, i === 12 ? "Revised approach based on recent observations." : null);
      h.executor.enqueue(success({ block: "observed_" + i }));
    }
    call(h.llm, "finish_step", { status: "success", message: "Fourteen actions recorded." });
    const report = await h.agent.runDelegatedStep(delegation("Distinct first request"));
    assert.equal(report.outcomes.length, 14);
    for (const request of h.llm.requests) {
      assert.ok(request.messages.length <= 20);
      assert.equal(request.messages[2]!.content, delegation().instruction);
      assert.equal(request.messages.filter((m) => m.content?.startsWith("Previous conversation summary:")).length, 1);
      protocolValid(request.messages);
    }
    const last = h.llm.requests.at(-1)!;
    assert.match(last.messages[0]!.content!, /observed_13/);
    assert.match(JSON.stringify(last.messages), /Revised approach/);
    if (mode === "compact") assert.ok(last.messages.some((m) => m.role === "assistant" && m.content?.includes("tool: dig")));
    const beforeSecond = h.llm.requests.length;
    call(h.llm, "finish_step", { status: "needs_user", message: "Fresh delegation." });
    await h.agent.runDelegatedStep(delegation("Distinct second request"));
    const fresh = h.llm.requests[beforeSecond]!;
    assert.equal(fresh.messages.length, 3);
    assert.doesNotMatch(JSON.stringify(fresh.messages), /Distinct first|Revised approach|observed_13/);
    assert.equal(h.agent.state().run, null);
  }
});

test("eight invalid responses retry with precise feedback and no side effects or invalid history", async () => {
  const h = await harness({ maxResponseRetries: 8 });
  h.llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [{ id: "bad-json", name: "goto", arguments: '{"position":' }] }, finishReason: "tool_calls" });
  h.llm.enqueue({ ...response("dig", spec("dig", 1).input), finishReason: "length" });
  h.llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [
    { id: "a", name: "goto", arguments: JSON.stringify(spec("goto", 1).input) },
    { id: "b", name: "dig", arguments: JSON.stringify(spec("dig", 1).input) },
  ] }, finishReason: "tool_calls" });
  call(h.llm, "goto", { position: '{"x":1,"y":-60,"z":0}' });
  call(h.llm, "set_plan", { tasks: [spec("dig", 1)] });
  call(h.llm, "dig", { input: spec("dig", 1).input });
  h.llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [{ id: "", name: "dig", arguments: JSON.stringify(spec("dig", 1).input) }] }, finishReason: "tool_calls" });
  h.llm.enqueue({ message: { role: "assistant", content: "An approach without a tool call." }, finishReason: "stop" });
  call(h.llm, "finish_step", { status: "failure", message: "No action attempted." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "failure");
  assert.equal(report.outcomes.length, 0);
  assert.equal(h.executor.started.length, 0);
  assert.equal(h.retries.length, 8);
  for (const request of h.llm.requests) assert.equal(request.messages.length, 3);
  assert.match(h.llm.requests[4]!.messages[0]!.content!, /position: Expected object, received string/);
  assert.ok(h.llm.requests.slice(1).every((r) => r.messages[0]!.content?.includes("Internal validation feedback")));
  assert.equal(h.inspector.listRounds().filter((r) => r.status === "invalid_response").length, 8);
});

test("a physical failure is observed before a changed action; later parsing failure preserves its actual outcome", async () => {
  const h = await harness({ maxResponseRetries: 0 });
  action(h.llm, "goto", 1);
  const actual = failure("NO_PATH", "No path.", { retryable: true, facts: { reason: "unreachable" } });
  h.executor.enqueue(actual);
  h.llm.enqueue({ message: { role: "assistant", content: "No tool call" }, finishReason: "stop" });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "failure");
  assert.equal(h.executor.started.length, 1);
  assert.deepEqual(report.outcomes[0]!.result, actual);
  assert.equal(h.agent.state().mode, "idle");
});

test("total tool budget includes reads and actions, excludes retries and reserves the final report", async () => {
  const h = await harness({ maxToolCalls: 3, maxResponseRetries: 1 });
  call(h.llm, "get_self", {});
  action(h.llm, "dig", 1);
  h.executor.enqueue(success({ block: "oak_log" }));
  call(h.llm, "get_inventory", {}); // Only the report fits in the final slot.
  call(h.llm, "finish_step", { status: "failure", message: "Could not verify pickup within the budget." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "failure");
  assert.equal(report.outcomes.length, 1);
  assert.equal(h.executor.started.length, 1);
  assert.equal(h.retries.length, 1);
  assert.match(h.llm.requests.at(-1)!.messages[0]!.content!, /tool call limit reached \(3\)/);
  assert.equal(h.llm.requests.at(-1)!.trace?.round, 2);
});

test("stop during thinking rejects late native actions and allows a fresh delegation", async () => {
  const h = await harness();
  const delayed = h.llm.enqueueDeferred({ ignoreAbort: true });
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => h.llm.requests.length === 1);
  let stopped = false;
  const stop = h.agent.requestStop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stopped, false);
  delayed.resolve(response("dig", spec("dig", 1).input));
  assert.equal((await pending).status, "interrupted");
  await stop;
  assert.equal(h.executor.started.length, 0);
  call(h.llm, "finish_step", { status: "needs_user", message: "New call." });
  await h.agent.runDelegatedStep(delegation());
  assert.equal(h.llm.requests.at(-1)!.messages.length, 3);
});

test("stop waits for the physical result and records the actual native tool failure", async () => {
  const h = await harness();
  action(h.llm, "dig", 1);
  const physical = h.executor.enqueueDeferred();
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => h.agent.state().mode === "executing");
  await assert.rejects(h.agent.runDelegatedStep(delegation()), /unavailable/);
  let stopped = false;
  const stop = h.agent.requestStop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stopped, false);
  assert.equal(h.executor.abortCount, 1);
  physical.resolve(failure("INTERRUPTED", "Dig aborted."));
  const report = await pending;
  await stop;
  assert.equal(report.status, "interrupted");
  assert.deepEqual(report.outcomes[0]!.result, failure("INTERRUPTED", "Dig aborted."));
  assert.equal(h.executor.started.length, 1);
  assert.equal(h.llm.requests.length, 1);
  const row = h.inspector.listRounds().find((r) => r.activity.startsWith("dig"))!;
  assert.equal(row.status, "aborted");
  assert.equal(row.failed, true);
});

test("stop through the real Executor waits for registered physical cleanup before handoff", async () => {
  let release!: () => void;
  let activeSignal: AbortSignal | undefined;
  const physical = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({
    execute: async (_name, _input, context) => {
      activeSignal = context.signal;
      context.deferCancellationUntil(physical);
      await physical;
      return success({ block: "oak_log" });
    },
  });
  action(h.llm, "dig", 1);
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => activeSignal !== undefined);
  let stopped = false;
  const stop = h.agent.requestStop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(activeSignal!.aborted, true);
  assert.equal(stopped, false);
  assert.notEqual(h.physicalExecutor.currentTask, null);
  assert.equal(h.llm.requests.length, 1);
  release();
  const report = await pending;
  await stop;
  assert.equal(report.status, "interrupted");
  assert.equal(h.physicalExecutor.currentTask, null);
  const result = report.outcomes[0]!.result;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INTERRUPTED");
  assert.equal(h.llm.requests.length, 1);
});

test("stop between validation and physical dispatch never starts the capability", async () => {
  const h = await harness();
  let stop: Promise<void> | undefined;
  h.inspector.recordToolStarted = () => { stop = h.agent.requestStop(); };
  action(h.llm, "dig", 1);
  assert.equal((await h.agent.runDelegatedStep(delegation())).status, "interrupted");
  await stop;
  assert.equal(h.executor.started.length, 0);
  const row = h.inspector.getRound(h.inspector.listRounds()[0]!.id)!;
  assert.equal(row.status, "aborted");
  assert.match(row.toolExecutions[0]!.result!, /tool was not executed/);
});

test("shutdown aborts thinking and prevents further delegations", async () => {
  const h = await harness();
  h.llm.enqueueDeferred();
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => h.llm.requests.length === 1);
  await h.agent.shutdown();
  assert.equal((await pending).status, "interrupted");
  await assert.rejects(h.agent.runDelegatedStep(delegation()), /unavailable/);
  assert.equal(h.executor.started.length, 0);
});

test("stop during an observation records its result but never makes the next LLM call", async () => {
  const h = await harness();
  let release!: () => void;
  let reads = 0;
  const waiting = new Promise<void>((r) => { release = r; });
  h.toolBridge.executeRead = async (tool) => {
    reads += 1;
    await waiting;
    return { toolCallId: tool.id, name: tool.name, ok: true, content: '{"ok":true,"value":{}}' };
  };
  call(h.llm, "get_self", {});
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => reads === 1);
  const stop = h.agent.requestStop();
  release();
  assert.equal((await pending).status, "interrupted");
  await stop;
  assert.equal(h.llm.requests.length, 1);
  assert.equal(h.inspector.listRounds()[0]!.status, "aborted");
});

test("an outcome observer failure cannot erase the physical TaskResult", async () => {
  const h = await harness({ onTaskFinished: async () => { throw new Error("Persistence unavailable."); } });
  action(h.llm, "dig", 1);
  h.executor.enqueue(success({ block: "oak_log" }));
  call(h.llm, "finish_step", { status: "success", message: "Block removed." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.outcomes[0]!.result.ok, true);
});

test("real workflow delegates direct actions and still verifies the report before checking off the step", async () => {
  const h = await harness();
  const workflow = workflowHarness(h);
  call(h.llm, "ask_planner", { instruction: "Plan the observed block removal." });
  h.llm.enqueue({ message: { role: "assistant", content: JSON.stringify({ steps: [{ title: "Remove one log", successCriteria: "Observed log becomes air." }] }) }, finishReason: "stop" });
  call(h.llm, "run_step", { step: 1, instruction: "Remove the observed log at (1, -60, 0)." });
  action(h.llm, "dig", 1, "Remove the observed target.");
  h.executor.enqueue(success({ position: { x: 1, y: -60, z: 0 }, block: "oak_log" }));
  call(h.llm, "finish_step", { status: "success", message: "Observed log removed." });
  call(h.llm, "complete_step", { step: 1 });
  call(h.llm, "reply", { outcome: "success", message: "Done." });
  workflow.agent.submitUserMessage("owner", "Remove the log.");
  await until(() => (workflow.agent.state() as { mode: string }).mode === "idle");
  assert.deepEqual(h.llm.requests.map((r) => r.trace?.phase), ["coordinator", "planner", "coordinator", "actioner", "actioner", "coordinator", "coordinator"]);
  assert.deepEqual(workflow.replies, ["Done."]);
  assert.equal(workflow.agent.task.steps[0]!.status, "done");
  assert.equal(h.agent.state().mode, "idle");
  assert.equal(h.llm.requests[3]!.messages[2]!.content, "Remove the observed log at (1, -60, 0).");
  const report = JSON.parse(h.llm.requests[5]!.messages.at(-1)!.content!).value.report;
  assert.equal(report.outcomes[0].capability, "dig");
  assert.equal(report.outcomes[0].result.ok, true);
  assert.equal(report.outcomes[0].task, undefined);
  assert.ok(workflow.agent.task.lastReport!.report.outcomes[0]!.task.id);
  assert.equal(h.llm.maxConcurrentRequests, 1);
  await workflow.agent.shutdown();
});

test("real workflow stop during a capability returns the interrupted report without deadlock", async () => {
  const h = await harness();
  const workflow = workflowHarness(h);
  call(h.llm, "ask_planner", { instruction: "Plan one dig." });
  h.llm.enqueue({ message: { role: "assistant", content: JSON.stringify({ steps: [{ title: "Dig", successCriteria: "Log becomes air." }] }) }, finishReason: "stop" });
  call(h.llm, "run_step", { step: 1, instruction: "Dig the observed log." });
  action(h.llm, "dig", 1);
  const physical = h.executor.enqueueDeferred();
  workflow.agent.submitUserMessage("owner", "Remove log.");
  await until(() => h.agent.state().mode === "executing");
  const stop = workflow.agent.requestStop("owner");
  physical.resolve(failure("INTERRUPTED", "Cancelled dig."));
  await stop;
  assert.equal((workflow.agent.state() as { mode: string }).mode, "stopped");
  assert.equal(workflow.agent.task.lastReport!.report.status, "interrupted");
  assert.equal(workflow.agent.task.lastReport!.report.outcomes.length, 1);
  assert.equal(workflow.agent.task.steps[0]!.status, "blocked");
  assert.equal(h.executor.started.length, 1);
  assert.equal(h.llm.requests.length, 4);
  assert.deepEqual(workflow.replies, ["Bot stopped. Use resume to continue."]);
  await workflow.agent.shutdown();
});

test("coordinator report projection retains observations and errors without task metadata", () => {
  const report = {
    status: "failure" as const, message: "Route blocked.",
    outcomes: [{ task: { ...spec("goto", 3), id: "uuid", createdAt: 123 }, result: failure("NO_PATH", "Blocked", { facts: { reason: "missing_scaffolding" } }) }],
  };
  const before = structuredClone(report);
  const view = actionReportForContext(report);
  assert.deepEqual(view.outcomes[0], { capability: "goto", input: report.outcomes[0]!.task.input, result: report.outcomes[0]!.result });
  assert.doesNotMatch(JSON.stringify(view), /uuid|createdAt/);
  assert.deepEqual(report, before);
});

function delegation(userObjective = "Collect one more log"): ActionDelegation {
  return { step: { step: 1, title: "Collect a log", successCriteria: "Bot inventory increases by one log." }, instruction: "Collect a new log, then verify the inventory.", userObjective, checklist: "- [ ] 1. Collect a log", projectSummary: "" };
}
function spec(capability: string, x: number): TaskSpec { return { capability, input: { position: { x, y: -60, z: 0 } } }; }
let nextCall = 0;
function response(name: string, input: unknown, content: string | null = null): LLMResponse {
  return { message: { role: "assistant", content, toolCalls: [{ id: "call_" + (++nextCall), name, arguments: JSON.stringify(input) }] }, finishReason: "tool_calls" };
}
function call(llm: FakeLLMClient, name: string, input: unknown, content: string | null = null): void { llm.enqueue(response(name, input, content)); }
function action(llm: FakeLLMClient, name: string, x: number, note: string | null = null): void { call(llm, name, spec(name, x).input, note); }
function protocolValid(messages: readonly LLMMessage[]): void {
  let pending: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") assert.equal(message.toolCallId, pending.shift());
    else { assert.equal(pending.length, 0); if (message.role === "assistant") pending = message.toolCalls?.map((c) => c.id) ?? []; }
  }
  assert.equal(pending.length, 0);
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 1)); }
  throw new Error("Expected state was not reached.");
}
async function harness(options: {
  maxResponseRetries?: number; maxToolCalls?: number; toolReplayMode?: "native" | "compact";
  onTaskFinished?: (outcome: ActionTaskOutcome) => Promise<void>;
  execute?: (name: string, input: unknown, context: ExecutionContext) => Promise<TaskResult>;
} = {}) {
  const llm = new FakeLLMClient();
  const executor = new ScriptedExecutor();
  const inspector = new AgentInspector(100);
  const retries: string[] = [];
  const world: WorldQueries = {
    getSelf: () => ({ position: { x: 0, y: -60, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20, onGround: true }),
    getInventory: () => ({ items: [], selectedItem: null }), getBlock: () => null,
    getBlockAccess: () => { throw new Error("Block access was not stubbed."); },
    findNearestBlocks: () => [], getNearbyEntities: () => [],
  };
  const capabilities = new CapabilityRegistry();
  for (const name of ["dig", "goto"]) capabilities.register({
    name, description: "Test " + name + ".",
    inputSchema: z.object({ position: BlockPositionSchema }).strict(),
    execute: async (input, context) => options.execute ? options.execute(name, input, context) : success(null),
  });
  const physicalExecutor = options.execute
    ? new Executor({ registry: capabilities, world, runtime: {} as MinecraftRuntime })
    : executor as unknown as Executor;
  const landmarks = { pinned: () => [], list: () => [] } as unknown as LandmarkMemory;
  const skills = { list: () => [] } as unknown as SkillRegistry;
  const toolBridge = new AgentToolBridge({ capabilities, queries: createDefaultWorldQueryRegistry(world), skills, skillLoader: {} as SkillLoader, landmarks });
  const prompts = await loadWorkflowPrompts(resolve(process.cwd(), "prompts"));
  const agent = new ActionAgent({
    llm, executor: physicalExecutor, inspector, toolBridge,
    contextBuilder: new ActionContextBuilder({ world, landmarks, systemPrompt: prompts.actioner, conversationSummaryPrompt: prompts.conversationSummary }),
    maxToolCalls: options.maxToolCalls, maxResponseRetries: options.maxResponseRetries ?? 0,
    toolReplayMode: options.toolReplayMode, onTaskFinished: options.onTaskFinished,
    temperature: 0, maxTokens: 4096, onRetry: async (message) => { retries.push(message); },
  });
  return { agent, llm, executor, physicalExecutor, inspector, retries, world, toolBridge, prompts, landmarks };
}
function workflowHarness(h: Awaited<ReturnType<typeof harness>>) {
  const replies: string[] = [];
  const agent = new WorkflowAgent({
    llm: h.llm, actionAgent: h.agent, world: h.world, landmarks: h.landmarks,
    queries: createDefaultWorldQueryRegistry(h.world), prompts: h.prompts, inspector: h.inspector,
    temperature: 0, maxTokens: 4096, maxRetries: 0, historyMaxChars: 30_000,
    summaryFile: { path: "test-only", save: async () => undefined } as unknown as WorkflowSummaryFile,
    respond: async (message) => { replies.push(message); },
  });
  return { agent, replies };
}
class ScriptedExecutor {
  readonly started: Task[] = [];
  currentTask: Task | null = null;
  abortCount = 0;
  private readonly queue: Array<TaskResult | Promise<TaskResult>> = [];
  enqueue(result: TaskResult): void { this.queue.push(result); }
  enqueueDeferred() {
    let resolve!: (result: TaskResult) => void;
    this.queue.push(new Promise<TaskResult>((r) => { resolve = r; }));
    return { resolve };
  }
  abortCurrent(): boolean { this.abortCount += 1; return this.currentTask !== null; }
  async execute(task: Task): Promise<TaskResult> {
    this.currentTask = task;
    this.started.push(task);
    try { return await (this.queue.shift() ?? success(null)); }
    finally { this.currentTask = null; }
  }
}
