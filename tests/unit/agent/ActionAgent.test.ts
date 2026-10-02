import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { ActionAgent } from "../../../src/agent/ActionAgent";
import { ActionContextBuilder } from "../../../src/agent/ActionContextBuilder";
import { actionReportForContext } from "../../../src/agent/ActionReportFormatter";
import type { ActionDelegation } from "../../../src/agent/ActionTypes";
import { AgentToolBridge } from "../../../src/agent/AgentToolBridge";
import { WorkflowAgent } from "../../../src/agent/WorkflowAgent";
import type { WorkflowSummaryFile } from "../../../src/agent/WorkflowState";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import type { Executor } from "../../../src/execution/Executor";
import { SequentialPlanRunner } from "../../../src/execution/SequentialPlanRunner";
import type { Task, TaskSpec } from "../../../src/execution/Task";
import { failure, success, type TaskResult } from "../../../src/execution/TaskResult";
import { FakeLLMClient } from "../../../src/llm/FakeLLMClient";
import type { LLMMessage, LLMResponse } from "../../../src/llm/LLMClient";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { loadWorkflowPrompts } from "../../../src/prompts/WorkflowPrompts";
import type { SkillLoader } from "../../../src/skills/SkillLoader";
import type { SkillRegistry } from "../../../src/skills/SkillRegistry";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";

test("delegation uses a single actioner prompt and returns a private report without intent or memory calls", async () => {
  const h = await harness();
  call(h.llm, "finish_step", { status: "needs_user", message: "No target supplied." });
  const report = await h.agent.runDelegatedStep(delegation(), { generationId: 42, delegation: 2 });
  assert.deepEqual(report, { status: "needs_user", message: "No target supplied.", outcomes: [] });
  assert.equal(h.agent.state().mode, "idle");
  assert.equal(h.llm.requests.length, 1);
  const request = h.llm.requests[0]!;
  assert.equal(request.trace?.phase, "actioner");
  assert.equal(request.trace?.generationId, 42);
  assert.equal(request.trace?.reflection, 2);
  assert.deepEqual(request.messages.map((m) => m.role), ["system", "assistant", "user"]);
  assert.equal(request.messages[2]!.content, "Collect a new log, then verify the inventory.");
  assert.deepEqual(h.retries, []);
});

test("queries, plan revisions and actions share the same tools and conversation without modes", async () => {
  const h = await harness();
  call(h.llm, "get_inventory", {});
  call(h.llm, "get_capability_schemas", { names: ["dig", "goto"] });
  plan(h.llm, [spec("goto", 1), spec("dig", 1)], "Approach then dig the observed block.");
  call(h.llm, "continue_plan", {});
  h.executor.enqueue(failure("NO_PATH", "Route blocked.", { facts: { reason: "no_scaffolding", distance: 8.123456 } }));
  call(h.llm, "get_self", {});
  plan(h.llm, [spec("dig", 2)], "Use the newly observed reachable block instead.");
  call(h.llm, "continue_plan", {});
  h.executor.enqueue(success({ block: "oak_log", position: { x: 2, y: -60, z: 0 } }));
  call(h.llm, "finish_step", { status: "success", message: "Observed block removed; inventory verified." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.deepEqual(h.executor.started.map((t) => [t.capability, (t.input as { position: { x: number } }).position.x]), [["goto", 1], ["dig", 2]]);
  assert.equal(report.outcomes.length, 2);
  const requests = h.llm.requests;
  for (const request of requests) {
    assert.equal(request.trace?.phase, "actioner");
    assert.deepEqual(request.tools, requests[0]!.tools);
    assert.equal(request.messages[2]!.content, delegation().instruction);
    protocolValid(request.messages);
  }
  assert.match(requests[4]!.messages[0]!.content!, /Approach then dig/);
  assert.match(requests[5]!.messages[0]!.content!, /NO_PATH/);
  assert.match(requests[7]!.messages[0]!.content!, /Use the newly observed reachable block instead/);
  assert.ok(requests[7]!.messages.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "get_self"));
  const rows = h.inspector.listRounds().map((r) => h.inspector.getRound(r.id)!);
  const failed = rows.find((r) => r.toolExecutions.some((e) => e.name === "continue_plan" && e.ok === false))!;
  assert.equal(failed.failed, true);
  assert.equal(failed.agentLabel, "Actioner");
  assert.equal(failed.stepLabel, "Step 1 — Collect a log");
});

test("set_plan never executes; continue_plan awaits exactly one action before any next LLM call", async () => {
  const h = await harness();
  plan(h.llm, [spec("dig", 1), spec("dig", 2)]);
  h.llm.enqueue(() => {
    assert.equal(h.executor.started.length, 0);
    return response("continue_plan", {});
  });
  const physical = h.executor.enqueueDeferred();
  h.llm.enqueue((request) => {
    assert.equal(h.executor.currentTask, null);
    assert.equal(h.executor.started.length, 1);
    assert.match(request.messages.at(-1)!.content!, /oak_log/);
    return response("finish_step", { status: "needs_user", message: "One action done, remaining step not verified." });
  });
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => h.agent.state().mode === "executing");
  assert.equal(h.llm.requests.length, 2);
  assert.equal(h.runner.remaining().length, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.llm.requests.length, 2);
  physical.resolve(success({ block: "oak_log" }));
  const report = await pending;
  assert.equal(report.outcomes.length, 1);
  assert.equal(h.executor.started.length, 1);
  assert.equal(h.llm.maxConcurrentRequests, 1);
  assert.equal(h.runner.remaining().length, 0);
});

test("bounded tool history pins the instruction and local plan, then resets on the next delegation", async () => {
  for (const mode of ["native", "compact"] as const) {
    const h = await harness({ toolReplayMode: mode });
    plan(h.llm, Array.from({ length: 14 }, (_, x) => spec("dig", x)), "Distinct local plan.");
    for (let i = 0; i < 14; i++) {
      call(h.llm, "continue_plan", {});
      h.executor.enqueue(success({ block: `observed_${i}` }));
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
    assert.match(last.messages[0]!.content!, /Distinct local plan/);
    assert.match(last.messages[0]!.content!, /observed_13/);
    assert.equal(last.messages.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "set_plan"), false);
    if (mode === "compact") assert.ok(last.messages.some((m) => m.role === "assistant" && m.content?.includes("tool: continue_plan")));
    const beforeSecond = h.llm.requests.length;
    call(h.llm, "finish_step", { status: "needs_user", message: "Fresh delegation." });
    await h.agent.runDelegatedStep(delegation("Distinct second request"));
    const fresh = h.llm.requests[beforeSecond]!;
    assert.equal(fresh.messages.length, 3);
    assert.doesNotMatch(JSON.stringify(fresh.messages), /Distinct first|Distinct local plan|observed_13/);
    assert.equal(h.agent.state().run, null);
  }
});

test("malformed, mixed and truncated responses retry without executing or appending invalid calls", async () => {
  const h = await harness({ maxResponseRetries: 4 });
  h.llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [{ id: "bad-json", name: "set_plan", arguments: '{"tasks":' }] }, finishReason: "tool_calls" });
  h.llm.enqueue({ ...response("set_plan", { description: "truncated", tasks: [spec("dig", 1)] }), finishReason: "length" });
  h.llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [
    { id: "mixed-plan", name: "set_plan", arguments: JSON.stringify({ description: "bad mix", tasks: [spec("dig", 2)] }) },
    { id: "mixed-read", name: "get_inventory", arguments: "{}" },
  ] }, finishReason: "tool_calls" });
  call(h.llm, "set_plan", { tasks: [spec("dig", 3)] }); // Missing required description.
  call(h.llm, "finish_step", { status: "failure", message: "No action attempted." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "failure");
  assert.equal(report.outcomes.length, 0);
  assert.equal(h.executor.started.length, 0);
  assert.equal(h.retries.length, 4);
  for (const request of h.llm.requests) assert.equal(request.messages.length, 3);
  assert.ok(h.llm.requests.slice(1).every((r) => r.messages[0]!.content?.includes("Internal validation feedback")));
  assert.equal(h.inspector.listRounds().filter((r) => r.status === "invalid_response").length, 4);
});

test("physical failure does not auto-advance, and a later parsing failure retains the actual outcome", async () => {
  const h = await harness({ maxResponseRetries: 0 });
  plan(h.llm, [spec("goto", 1), spec("dig", 1)]);
  call(h.llm, "continue_plan", {});
  const actual = failure("NO_PATH", "No path.", { retryable: true, facts: { reason: "unreachable" } });
  h.executor.enqueue(actual);
  h.llm.enqueue({ message: { role: "assistant", content: "not a tool call" }, finishReason: "stop" });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "failure");
  assert.equal(h.executor.started.length, 1);
  assert.deepEqual(report.outcomes[0]!.result, actual);
  assert.equal(h.runner.remaining().length, 0);
  assert.equal(h.agent.state().mode, "idle");
});

test("empty queue, query loops and repeated plan-only revisions remain guarded", async () => {
  const empty = await harness({ maxResponseRetries: 1 });
  call(empty.llm, "continue_plan", {});
  call(empty.llm, "finish_step", { status: "needs_user", message: "Need a plan first." });
  assert.equal((await empty.agent.runDelegatedStep(delegation())).status, "needs_user");
  assert.equal(empty.executor.started.length, 0);

  const reads = await harness({ maxToolRounds: 1, maxResponseRetries: 1 });
  call(reads.llm, "get_self", {});
  call(reads.llm, "get_self", {});
  call(reads.llm, "finish_step", { status: "failure", message: "Query budget reached." });
  assert.equal((await reads.agent.runDelegatedStep(delegation())).status, "failure");
  assert.match(reads.llm.requests.at(-1)!.messages[0]!.content!, /Query round limit reached/);

  const plans = await harness({ maxConsecutivePlansWithoutAction: 2, maxResponseRetries: 1 });
  for (let i = 0; i < 3; i++) plan(plans.llm, [spec("dig", i)]);
  call(plans.llm, "finish_step", { status: "failure", message: "Could not choose an action." });
  assert.equal((await plans.agent.runDelegatedStep(delegation())).status, "failure");
  assert.equal(plans.executor.started.length, 0);
  assert.match(plans.llm.requests.at(-1)!.messages[0]!.content!, /Repeated plan replacements/);
});

test("stop during thinking rejects late LLM side effects and permits a fresh delegation", async () => {
  const h = await harness();
  const delayed = h.llm.enqueueDeferred({ ignoreAbort: true });
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => h.llm.requests.length === 1);
  let stopped = false;
  const stop = h.agent.requestStop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stopped, false);
  delayed.resolve(response("set_plan", { description: "Late plan.", tasks: [spec("dig", 1)] }));
  assert.equal((await pending).status, "interrupted");
  await stop;
  assert.equal(h.executor.started.length, 0);
  assert.equal(h.runner.remaining().length, 0);
  call(h.llm, "finish_step", { status: "needs_user", message: "New call." });
  await h.agent.runDelegatedStep(delegation());
  assert.equal(h.llm.requests.at(-1)!.messages.length, 3);
});

test("stop waits for the physical result, reports it, and never starts the remaining action", async () => {
  const h = await harness();
  plan(h.llm, [spec("dig", 1), spec("dig", 2)]);
  call(h.llm, "continue_plan", {});
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
  assert.equal(report.outcomes.length, 1);
  assert.deepEqual(report.outcomes[0]!.result, failure("INTERRUPTED", "Dig aborted."));
  assert.equal(h.executor.started.length, 1);
  assert.equal(h.llm.requests.length, 2);
  assert.equal(h.runner.remaining().length, 0);
  const row = h.inspector.listRounds().find((r) => r.activity.includes("continue_plan"))!;
  assert.equal(row.status, "aborted");
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

test("stop during a batched read records all outcomes without executing the remaining query", async () => {
  const h = await harness();
  let release!: () => void;
  let reads = 0;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  h.toolBridge.executeRead = async (call) => {
    reads += 1;
    await waiting;
    return { toolCallId: call.id, name: call.name, ok: true, content: '{"ok":true,"value":{}}' };
  };
  h.llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [
    { id: "a", name: "get_self", arguments: "{}" }, { id: "b", name: "get_inventory", arguments: "{}" },
  ] }, finishReason: "tool_calls" });
  const pending = h.agent.runDelegatedStep(delegation());
  await until(() => reads === 1);
  const stop = h.agent.requestStop();
  release();
  assert.equal((await pending).status, "interrupted");
  await stop;
  assert.equal(reads, 1);
  assert.equal(h.llm.requests.length, 1);
  const row = h.inspector.getRound(h.inspector.listRounds()[0]!.id)!;
  assert.equal(row.status, "aborted");
  assert.deepEqual(row.toolExecutions.map((e) => e.ok), [true, false]);
  assert.match(row.toolExecutions[1]!.result!, /tool was not executed/);
});

test("real workflow hands off to the flat actioner and verifies its report before completing the step", async () => {
  const h = await harness();
  const workflow = workflowHarness(h);
  call(h.llm, "ask_planner", { instruction: "Plan the observed block removal." });
  h.llm.enqueue({ message: { role: "assistant", content: JSON.stringify({ steps: [{ title: "Remove one log", successCriteria: "Observed log becomes air." }] }) }, finishReason: "stop" });
  call(h.llm, "run_step", { step: 1, instruction: "Remove the observed log at (1, -60, 0)." });
  call(h.llm, "get_capability_schemas", { names: ["dig"] });
  plan(h.llm, [spec("dig", 1)], "Dig the observed log and check the result.");
  call(h.llm, "continue_plan", {});
  h.executor.enqueue(success({ position: { x: 1, y: -60, z: 0 }, block: "oak_log" }));
  call(h.llm, "finish_step", { status: "success", message: "Observed log removed." });
  call(h.llm, "complete_step", { step: 1 });
  call(h.llm, "reply", { outcome: "success", message: "Done." });
  workflow.agent.submitUserMessage("owner", "Remove the log.");
  await until(() => (workflow.agent.state() as { mode: string }).mode === "idle");
  assert.deepEqual(h.llm.requests.map((r) => r.trace?.phase), ["coordinator", "planner", "coordinator", "actioner", "actioner", "actioner", "actioner", "coordinator", "coordinator"]);
  assert.deepEqual(workflow.replies, ["Done."]);
  assert.equal(workflow.agent.task.steps[0]!.status, "done");
  assert.equal(h.agent.state().mode, "idle");
  const action = h.llm.requests[3]!;
  assert.equal(action.messages[2]!.content, "Remove the observed log at (1, -60, 0).");
  assert.match(action.messages[0]!.content!, /Observed log becomes air/);
  const report = JSON.parse(h.llm.requests[7]!.messages.at(-1)!.content!).value.report;
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
  plan(h.llm, [spec("dig", 1), spec("dig", 2)]);
  call(h.llm, "continue_plan", {});
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
  assert.equal(h.llm.requests.length, 5);
  assert.deepEqual(workflow.replies, ["Bot stopped. Use resume to continue."]);
  await workflow.agent.shutdown();
});

test("coordinator report projection retains observed evidence and errors without runner metadata", () => {
  const report = {
    status: "failure" as const, message: "Route blocked after an attempted dig.",
    outcomes: [{ task: { ...spec("goto", 3), id: "uuid", createdAt: 123 }, result: failure("NO_PATH", "Blocked", { retryable: true, facts: { reason: "missing_scaffolding" } }) }],
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
function response(name: string, input: unknown): LLMResponse {
  return { message: { role: "assistant", content: null, toolCalls: [{ id: `call_${++nextCall}`, name, arguments: JSON.stringify(input) }] }, finishReason: "tool_calls" };
}
function call(llm: FakeLLMClient, name: string, input: unknown): void { llm.enqueue(response(name, input)); }
function plan(llm: FakeLLMClient, tasks: readonly TaskSpec[], description = "Perform the observed actions and verify."): void { call(llm, "set_plan", { description, tasks }); }

function protocolValid(messages: readonly LLMMessage[]): void {
  let pending: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") assert.equal(message.toolCallId, pending.shift());
    else {
      assert.equal(pending.length, 0);
      if (message.role === "assistant") pending = message.toolCalls?.map((c) => c.id) ?? [];
    }
  }
  assert.equal(pending.length, 0);
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 1)); }
  throw new Error("Expected state was not reached.");
}

async function harness(options: { maxResponseRetries?: number; maxToolRounds?: number; maxConsecutivePlansWithoutAction?: number; toolReplayMode?: "native" | "compact" } = {}) {
  const llm = new FakeLLMClient();
  const executor = new ScriptedExecutor();
  const runner = new SequentialPlanRunner(executor as unknown as Executor);
  const inspector = new AgentInspector(100);
  const retries: string[] = [];
  const world: WorldQueries = {
    getSelf: () => ({ position: { x: 0, y: -60, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20, onGround: true }),
    getInventory: () => ({ items: [], selectedItem: null }), getBlock: () => null,
    getBlockAccess: () => { throw new Error("Block access was not stubbed."); },
    findNearestBlocks: () => [], getNearbyEntities: () => [],
  };
  const capabilities = new CapabilityRegistry();
  for (const name of ["dig", "goto"]) capabilities.register({ name, description: `Test ${name}.`, inputSchema: z.object({ position: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict() }).strict(), execute: async () => success(null) });
  const landmarks = { pinned: () => [], list: () => [] } as unknown as LandmarkMemory;
  const skills = { list: () => [] } as unknown as SkillRegistry;
  const toolBridge = new AgentToolBridge({ capabilities, queries: createDefaultWorldQueryRegistry(world), skills, skillLoader: {} as SkillLoader, landmarks });
  const prompts = await loadWorkflowPrompts(resolve(process.cwd(), "prompts"));
  const agent = new ActionAgent({
    llm, runner, inspector, toolBridge,
    contextBuilder: new ActionContextBuilder({ world, landmarks, capabilities, systemPrompt: prompts.actioner, conversationSummaryPrompt: prompts.conversationSummary }),
    maxToolRounds: options.maxToolRounds ?? 4, maxResponseRetries: options.maxResponseRetries ?? 0,
    maxConsecutivePlansWithoutAction: options.maxConsecutivePlansWithoutAction ?? 8,
    toolReplayMode: options.toolReplayMode,
    temperature: 0, maxTokens: 4096, onRetry: async (message) => { retries.push(message); },
  });
  return { agent, llm, executor, runner, inspector, retries, world, toolBridge, prompts, landmarks };
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
