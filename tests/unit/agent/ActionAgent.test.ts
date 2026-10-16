import assert from "node:assert/strict";
import { loadRecipeTools } from "../../support/recipes";
import { resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { ActionAgent } from "../../../src/agent/ActionAgent";
import { WorkflowState } from "../../../src/agent/WorkflowState";
import { StepEvaluationService } from "../../../src/agent/StepEvaluationService";
import { ToolCallJournal } from "../../../src/execution/ToolCallJournal";
import { inventoryTotals } from "../../../src/runtime/InventoryAdapter";
import { ActionContextBuilder } from "../../../src/agent/ActionContextBuilder";
import { actionReportForContext } from "../../../src/agent/ActionReportFormatter";
import type { ActionDelegation, ActionTaskOutcome } from "../../../src/agent/ActionTypes";
import { AgentToolBridge } from "../../../src/agent/AgentToolBridge";
import { WorkflowAgent } from "../../../src/agent/WorkflowAgent";
import type { WorkflowSummaryFile } from "../../../src/agent/WorkflowState";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { BuildCapability } from "../../../src/capabilities/Build";
import { ACTION_MAX_TOOL_CALLS } from "../../../src/config";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { Executor } from "../../../src/execution/Executor";
import type { Task, TaskSpec } from "../../../src/execution/Task";
import { failure, success, type TaskResult } from "../../../src/execution/TaskResult";
import { FakeLLMClient } from "../../support/FakeLLMClient";
import { LLMError } from "../../../src/llm/LLMError";
import type { ContextBudget } from "../../../src/agent/ContextCompactor";
import type { LLMMessage, LLMResponse } from "../../../src/llm/LLMClient";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { loadWorkflowPrompts } from "../../../src/prompts/WorkflowPrompts";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { SkillLoader } from "../../../src/skills/SkillLoader";
import type { SkillRegistry } from "../../../src/skills/SkillRegistry";
import { BlockPositionSchema } from "../../../src/shared/types";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";

test("actioner rejects a missing or stale blueprint before physical execution and accepts the selected reference", async () => {
  const id = "bp_12345678-1234-1234-1234-123456789abc";
  const other = "bp_22345678-1234-1234-1234-123456789abc";
  for (const mode of ["missing", "stale", "selected"] as const) {
    const h = await harness();
    call(h.llm, "build", { blueprintId: mode === "stale" ? other : id, origin: { x: 0, y: -60, z: 0 } });
    if (mode === "selected") call(h.llm, "finish_step", { status: "success", message: "Verified structure." });
    const d: ActionDelegation = { ...delegation(), ...(mode === "missing" ? {} : {
      construction: { instruction: "Small house", blueprint: { blueprintId: id, name: "house", description: "House", formatVersion: 1,
        minecraftVersion: "1.21.11", dimensions: { width: 5, depth: 5, height: 4 }, materials: [{ item: "oak_planks", quantity: 55 }] } },
    }) };
    const report = await h.agent.runDelegatedStep(d);
    assert.equal(h.executor.started.length, mode === "selected" ? 1 : 0);
    assert.equal(report.status, mode === "selected" ? "success" : "failure");
    if (mode !== "selected") assert.match(report.message, /blueprint/);
    else assert.match(h.llm.requests[1]!.messages[0]!.content!, /oak_planks x55/);
  }
});

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
  assert.equal(request.messages[2]!.content, "Execute step 1 of the current plan.");
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
    assert.equal(request.messages[2]!.content, "Execute step 1 of the current plan.");
    assert.doesNotMatch(request.messages[0]!.content!, /## Local Plan|Pending actions|## Available Capabilities/);
    protocolValid(request.messages);
  }
  assert.match(JSON.stringify(h.llm.requests[3]!.messages), /Approach the observed log/);
  assert.doesNotMatch(h.llm.requests[2]!.messages[0]!.content!, /NO_PATH/); // The result is in tool history, not duplicated in system.
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
    assert.deepEqual(JSON.parse(request.messages.at(-1)!.content!), { actionNumber: 1, ok: true, value: { block: "oak_log" } });
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

test("history keeps notes and the instruction until compression, and resets after handoff", async () => {
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
      assert.ok(request.messages.some((message) => message.role === "user"));
      assert.equal(request.messages[2]!.content, "Execute step 1 of the current plan.");
      assert.equal(request.messages.filter((m) => m.content?.startsWith("Previous conversation summary:")).length, 1);
      protocolValid(request.messages);
    }
    const last = h.llm.requests.at(-1)!;
    assert.doesNotMatch(last.messages[0]!.content!, /observed_13/);
    assert.match(last.messages.at(-1)!.content!, /observed_13/);
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
  const row = h.inspector.listRounds().find((r) => r.activity.startsWith("Action #1 · dig"))!;
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

test("a still-settling interrupted action keeps an unknown after snapshot even after late completion", async () => {
  let release!: () => void;
  let began = false;
  const physical = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({ cancellationGraceMs: 0, execute: async () => {
    began = true;
    await physical;
    return success(null);
  } });
  action(h.llm, "dig", 1);
  const pending = h.agent.runDelegatedStep(delegation());
  try {
    await until(() => began);
    await h.agent.requestStop();
    assert.equal((await pending).status, "interrupted");
    assert.equal(h.journal.get(1)!.after, null);
    assert.notEqual(h.physicalExecutor.currentTask, null);
  } finally { release(); }
  await until(() => h.physicalExecutor.currentTask === null);
  const read = await h.toolBridge.executeRead({ id: "diff", name: "get_inventory_diff_after", arguments: '{"actionNumber":1}' });
  assert.equal(read.ok, false);
  assert.equal(JSON.parse(read.content).error.code, "OBSERVATION_UNAVAILABLE");
  assert.equal(h.journal.get(1)!.after, null);
});

test("failed capabilities still retain observed inventory changes", async () => {
  let count = 2;
  const h = await harness({ execute: async () => { count = 1; return failure("WORLD_CHANGED", "Partial operation."); } });
  h.world.getInventory = () => ({ items: [{ name: "dirt", displayName: "Dirt", type: 1, metadata: 0, count, slot: 36 }], selectedItem: null });
  action(h.llm, "goto", 1);
  call(h.llm, "get_inventory_diff_after", { actionNumber: 1 });
  h.llm.enqueue((request) => {
    const result = JSON.parse(request.messages.at(-1)!.content!);
    assert.equal(result.value.toolSucceeded, false);
    assert.match(result.value.diff, /- dirt: 2\n\+ dirt: 1/);
    return response("finish_step", { status: "failure", message: "One dirt consumed before failure." });
  });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "failure");
  assert.equal(report.outcomes[0]!.actionNumber, 1);
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
  call(h.llm, "submit_plan", { steps: [{ title: "Remove one log", successCriteria: "Observed log becomes air." }] });
  call(h.llm, "run_step", { step: 1 });
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
  assert.equal(h.llm.requests[3]!.messages[2]!.content, "Execute step 1 of the current plan.");
  const report = JSON.parse(h.llm.requests[5]!.messages.at(-1)!.content!).value.report;
  assert.equal(report.outcomes[0].capability, "dig");
  assert.equal(report.outcomes[0].result.ok, true);
  assert.equal(report.outcomes[0].task, undefined);
  assert.ok(workflow.agent.task.reports[1]!.report.outcomes[0]!.task.id);
  assert.equal(h.llm.maxConcurrentRequests, 1);
  await workflow.agent.shutdown();
});

test("real workflow stop during a capability returns the interrupted report without deadlock", async () => {
  const h = await harness();
  const workflow = workflowHarness(h);
  call(h.llm, "ask_planner", { instruction: "Plan one dig." });
  call(h.llm, "submit_plan", { steps: [{ title: "Dig", successCriteria: "Log becomes air." }] });
  call(h.llm, "run_step", { step: 1 });
  action(h.llm, "dig", 1);
  const physical = h.executor.enqueueDeferred();
  workflow.agent.submitUserMessage("owner", "Remove log.");
  await until(() => h.agent.state().mode === "executing");
  const stop = workflow.agent.requestStop("owner");
  physical.resolve(failure("INTERRUPTED", "Cancelled dig."));
  await stop;
  assert.equal((workflow.agent.state() as { mode: string }).mode, "stopped");
  assert.equal(workflow.agent.task.reports[1]!.report.status, "interrupted");
  assert.equal(workflow.agent.task.reports[1]!.report.outcomes.length, 1);
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

test("coordinator and actioner share numbering and can inspect individual and whole-delegation diffs", async () => {
  for (const mode of ["native", "compact"] as const) {
    let inventoryCount = 1;
    const h = await harness({ toolReplayMode: mode, execute: async () => {
      inventoryCount += 1;
      return success({ block: "oak_log" });
    } });
    h.world.getInventory = () => ({ items: [{ name: "oak_log", displayName: "Oak Log", count: inventoryCount, slot: 36, type: 1, metadata: 0 }], selectedItem: null });
    const workflow = workflowHarness(h);
    call(h.llm, "ask_planner", { instruction: "Collect a new log." }); // #1
    call(h.llm, "submit_plan", { steps: [{ title: "Collect log", successCriteria: "One new log." }] }); // #2
    call(h.llm, "run_step", { step: 1 }); // #3, finishes after children
    call(h.llm, "get_inventory", {}); // #4
    action(h.llm, "dig", 1); // #5
    call(h.llm, "get_inventory_diff_after", { actionNumber: 5 }); // #6
    h.llm.enqueue((request) => {
      const result = JSON.parse(request.messages.at(-1)!.content!);
      assert.equal(result.actionNumber, 6);
      assert.equal(result.value.actionNumber, 5);
      assert.match(result.value.diff, /- oak_log: 1\n\+ oak_log: 2/);
      return response("finish_step", { status: "success", message: "One new log confirmed by action #5." }); // #7
    });
    h.llm.enqueue((request) => {
      const result = JSON.parse(request.messages.at(-1)!.content!);
      assert.equal(result.actionNumber, 3);
      assert.equal(result.value.report.outcomes[0].actionNumber, 5);
      return response("get_inventory_diff_after", { actionNumber: 3 }); // #8
    });
    h.llm.enqueue((request) => {
      const result = JSON.parse(request.messages.at(-1)!.content!);
      assert.equal(result.actionNumber, 8);
      assert.equal(result.value.actionNumber, 3);
      assert.match(result.value.diff, /- oak_log: 1\n\+ oak_log: 2/);
      return response("reply", { outcome: "answer", message: "Observed the gain." }); // #9
    });
    workflow.agent.submitUserMessage("owner", "Collect one additional log.");
    await until(() => (workflow.agent.state() as { mode: string }).mode === "idle");
    assert.deepEqual(workflow.replies, ["Observed the gain."]);
    const executions = h.inspector.listRounds().flatMap((r) => h.inspector.getRound(r.id)!.toolExecutions);
    assert.deepEqual(executions.map((e) => e.actionNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(h.journal.get(5)!.completed, true);
    assert.match(h.inspector.listRounds().find((r) => r.activity.includes("dig"))!.activity, /Action #5/);
    call(h.llm, "reply", { outcome: "answer", message: "New request." });
    workflow.agent.submitUserMessage("owner", "Hello again.");
    await until(() => (workflow.agent.state() as { mode: string }).mode === "idle");
    assert.equal(h.journal.get(5), undefined);
    assert.equal(h.journal.get(10)!.tool, "reply");
    await workflow.agent.shutdown();
  }
});

test("actioner receives concrete rejected arguments and corrects them without executing an invalid call", async () => {
  const h = await harness({ maxResponseRetries: 1 });
  call(h.llm, "goto", { position: "[2, -60, 5]" });
  h.llm.enqueue((request) => {
    const feedback = request.messages[0]!.content!;
    assert.match(feedback, /Invalid arguments for "goto"/);
    assert.match(feedback, /Field position:/);
    assert.match(feedback, /\[2, -60, 5\]/);
    assert.match(feedback, /Expected schema:/);
    assert.match(feedback, /No tool was executed/);
    assert.match(feedback, /Example:/);
    assert.equal(h.executor.started.length, 0);
    return response("goto", { position: { x: 2, y: -60, z: 5 } });
  });
  h.executor.enqueue(success({ position: { x: 2, y: -60, z: 5 } }));
  call(h.llm, "finish_step", { status: "success", message: "Arrived." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "success");
  assert.equal(report.outcomes[0]!.actionNumber, 1);
  assert.equal(h.executor.started.length, 1);
});

function delegation(userObjective = "Collect one more log"): ActionDelegation {
  return { step: { step: 1, title: "Collect a log", successCriteria: "Bot inventory increases by one log." }, planVersion: 1, userObjective, checklist: "- [ ] 1. Collect a log", projectSummary: "", reports: [] };
}

test("actioner evaluates only its own plan step, uses text feedback and keeps structured debug evidence", async () => {
  const task = new WorkflowState();
  task.applyPlan([1, 2].map(() => ({ title: "Have sticks", successCriteria: "Four sticks", checks: "inventory_count(stick) >= 4" })), [], () => true);
  let reads = 0;
  const h = await harness({ stepEvaluator: new StepEvaluationService(task, async () => { reads++; return { known: true, items: { stick: 2 } }; }) });
  call(h.llm, "evaluate_step", { step: 2 });
  call(h.llm, "evaluate_step", { step: 1 });
  call(h.llm, "finish_step", { status: "needs_user", message: "Only two sticks; no action taken." });
  const report = await h.agent.runDelegatedStep({ ...delegation(), step: task.steps[0]!, planVersion: task.planVersion, checklist: task.checklist() });
  assert.equal(report.outcomes.length, 0);
  assert.equal(h.executor.started.length, 0);
  assert.equal(reads, 1);
  assert.match(h.llm.requests[1]!.messages.at(-1)!.content!, /INVALID_STEP/);
  assert.match(h.llm.requests[2]!.messages.at(-1)!.content!, /stick: 2 >= 4 — false/);
  const rounds = h.inspector.listRounds();
  assert.equal(rounds[0]!.failed, true);
  assert.equal(rounds[1]!.failed, false);
  assert.equal(JSON.parse(h.inspector.getRound(rounds[1]!.id)!.toolExecutions[0]!.result!).value.verdict, false);
  assert.ok(h.llm.requests[0]!.tools!.some(t => t.name === "evaluate_step"));
  assert.ok(!h.llm.requests[0]!.tools!.some(t => t.name === "inventory_count"));
  assert.equal(task.steps[0]!.status, "pending");
});

test("actioner reads the same recipe tools as planner with readable replay, structured logs and no physical action", async () => {
  for (const toolReplayMode of ["native", "compact"] as const) {
    const h = await harness({ toolReplayMode });
    call(h.llm, "read_recipe", { item: "wooden_axe" });
    call(h.llm, "read_recipe", { item: "stick" });
    call(h.llm, "finish_step", { status: "needs_user", message: "Recipe checked, no craft executed." });
    const report = await h.agent.runDelegatedStep(delegation());
    assert.equal(report.outcomes.length, 0);
    assert.equal(h.executor.started.length, 0);
    assert.match(h.llm.requests[1]!.messages.at(-1)!.content!, /Action #1\nwooden_axe x1 per craft/);
    assert.match(h.llm.requests[2]!.messages.map(m => m.content).join("\n"), /\[A\] \[A\] \[ \]/);
    protocolValid(h.llm.requests[2]!.messages);
    const first = h.inspector.getRound(h.inspector.listRounds()[0]!.id)!.toolExecutions[0]!;
    assert.equal(JSON.parse(first.result!).value.ingredients.oak_planks, 3);
    assert.equal(h.journal.get(1)!.tracksInventory, false);
  }
});

test("actioner retries malformed transport responses before invoking any action", async () => {
  const h = await harness({ maxResponseRetries: 1 });
  h.llm.enqueue(() => { throw new LLMError("INVALID_RESPONSE", "Empty response"); });
  call(h.llm, "finish_step", { status: "needs_user", message: "Nothing executed." });
  const report = await h.agent.runDelegatedStep(delegation());
  assert.equal(report.status, "needs_user");
  assert.equal(h.executor.started.length, 0);
  assert.equal(h.retries.length, 1);
});
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
  stepEvaluator?: StepEvaluationService;
  contextBudget?: ContextBudget;
  maxResponseRetries?: number; maxToolCalls?: number; toolReplayMode?: "native" | "compact";
  cancellationGraceMs?: number;
  onTaskFinished?: (outcome: ActionTaskOutcome) => Promise<void>;
  execute?: (name: string, input: unknown, context: ExecutionContext) => Promise<TaskResult>;
} = {}) {
  const llm = new FakeLLMClient();
  const executor = new ScriptedExecutor();
  const inspector = new AgentInspector(100);
  const retries: string[] = [];
  const world: WorldQueries = {
    isKnownName: () => true,
    getSelf: () => ({ position: { x: 0, y: -60, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20, onGround: true }),
    getInventory: () => ({ items: [], selectedItem: null }), getBlock: () => null,
    getBlockAccess: () => { throw new Error("Block access was not stubbed."); },
    findNearestBlocks: async () => [], getNearbyEntities: () => [],
  };
  const capabilities = new CapabilityRegistry();
  capabilities.register(new BuildCapability());
  for (const name of ["dig", "goto"]) capabilities.register({
    name, description: "Test " + name + ".",
    inputSchema: z.object({ position: BlockPositionSchema }).strict(),
    execute: async (input, context) => options.execute ? options.execute(name, input, context) : success(null),
  });
  const physicalExecutor = options.execute
    ? new Executor({ registry: capabilities, world, runtime: {} as MinecraftRuntime, cancellationGraceMs: options.cancellationGraceMs })
    : executor as unknown as Executor;
  const landmarks = { pinned: () => [], list: () => [] } as unknown as LandmarkMemory;
  const journal = new ToolCallJournal(() => physicalExecutor.currentTask ? null : inventoryTotals(world.getInventory().items));
  const skills = { list: () => [] } as unknown as SkillRegistry;
  const recipes = await loadRecipeTools();
  const toolBridge = new AgentToolBridge({ stepEvaluator: options.stepEvaluator, recipes, capabilities, queries: createDefaultWorldQueryRegistry(world, journal), skills, skillLoader: {} as SkillLoader, landmarks });
  const prompts = await loadWorkflowPrompts(resolve(process.cwd(), "prompts"));
  const agent = new ActionAgent({
    llm, journal, executor: physicalExecutor, inspector, toolBridge, contextSummaryPrompt: prompts.contextSummary, contextBudget: options.contextBudget,
    contextBuilder: new ActionContextBuilder({ world, landmarks, systemPrompt: prompts.actioner, conversationSummaryPrompt: prompts.conversationSummary }),
    maxToolCalls: options.maxToolCalls, maxResponseRetries: options.maxResponseRetries ?? 0,
    toolReplayMode: options.toolReplayMode, onTaskFinished: options.onTaskFinished,
    temperature: 0, maxTokens: 4096, onRetry: async (message) => { retries.push(message); },
  });
  return { agent, llm, executor, physicalExecutor, inspector, retries, world, toolBridge, prompts, landmarks, journal, recipes };
}

test("actioner compresses its private history and keeps its delegation and latest outcome", async () => {
  const h = await harness({ contextBudget: { charsPerToken: 3, compactAtTokens: 9000, targetTokens: 6000, summaryMaxChars: 300 } });
  let actions = 0;
  for (let i = 0; i < 40; i++) h.executor.enqueue(success({ observed: "oak_log", details: "x".repeat(1100) }));
  for (let i = 0; i < 100; i++) h.llm.enqueue((request) => {
    if (request.trace?.phase === "actioner_context_summary") {
      return { message: { role: "assistant", content: '{"summary":"Several dig operations succeeded. Pickup still unverified."}' }, finishReason: "stop" };
    }
    if (actions++ < 40) return response("dig", spec("dig", 1).input);
    return response("finish_step", { status: "needs_user", message: "Pickup still unverified." });
  });
  const report = await h.agent.runDelegatedStep(delegation("Distinct current objective"));
  assert.equal(report.status, "needs_user");
  assert.equal(report.outcomes.length, 40);
  assert.ok(h.llm.requests.some((r) => r.trace?.phase === "actioner_context_summary"));
  const last = h.llm.requests.at(-1)!;
  assert.match(last.messages[0]!.content!, /Distinct current objective/);
  assert.match(last.messages[1]!.content!, /Pickup still unverified/);
  assert.equal(last.messages[2]!.content, "Execute step 1 of the current plan.");
  assert.equal(last.messages.at(-1)!.role, "tool");
  protocolValid(last.messages);
});
function workflowHarness(h: Awaited<ReturnType<typeof harness>>) {
  const replies: string[] = [];
  const agent = new WorkflowAgent({
    recipes: h.recipes,
    llm: h.llm, actionAgent: h.agent, world: h.world, landmarks: h.landmarks, journal: h.journal,
    architectAgent: { run: async () => { throw new Error("Unexpected Architect delegation in this test."); } },
    actionTools: h.toolBridge.catalog.build(),
    queries: createDefaultWorldQueryRegistry(h.world, h.journal), prompts: h.prompts, inspector: h.inspector,
    temperature: 0, maxTokens: 4096, maxRetries: 0,
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
