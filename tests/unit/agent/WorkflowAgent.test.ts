import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ActionAgent } from "../../../src/agent/ActionAgent";
import type { ActionDelegation, DelegatedActionReport } from "../../../src/agent/ActionTypes";
import { WorkflowAgent } from "../../../src/agent/WorkflowAgent";
import { WorkflowSummaryFile } from "../../../src/agent/WorkflowState";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { success } from "../../../src/execution/TaskResult";
import { FakeLLMClient } from "../../support/FakeLLMClient";
import type { LLMMessage } from "../../../src/llm/LLMClient";
import { LLMError } from "../../../src/llm/LLMError";
import type { ContextBudget } from "../../../src/agent/ContextCompactor";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("coordinator native tools exclude capabilities and world state is injected only in system", async () => {
  const h = await harness();
  try {
    tool(h.llm, "reply", { outcome: "answer", message: "Empty." });
    h.agent.submitUserMessage("owner", "Inventory?");
    await idle(h.agent);
    assert.deepEqual(h.replies, ["Empty."]);
    const request = h.llm.requests[0]!;
    assert.deepEqual(request.messages.map((m) => m.role), ["system", "assistant", "user"]);
    assert.equal(request.messages[2]?.content, "Inventory?");
    assert.match(request.messages[1]!.content!, /Previous conversation summary: empty/);
    assert.match(request.messages[0]!.content!, /## World Context\nBot position:/);
    assert.equal(section(request.messages, "Task Context"), "No plan yet.");
    assert.equal(section(request.messages, "Task Summary"), undefined);
    assert.equal(section(request.messages, "Instruction"), undefined);
    assert.doesNotMatch(request.messages[0]!.content!, /Inventory\?|objective|summaryVersion|planVersion|lastReport|capabilities/);
    assert.equal(request.responseFormat, undefined);
    const names = request.tools!.map((t) => t.name);
    for (const name of ["reply", "ask_planner", "run_step", "complete_step", "refresh_summary", "get_inventory", "get_voxel_view", "get_block_access", "get_dropped_items"]) assert.ok(names.includes(name));
    for (const name of ["dig", "goto", "set_plan", "add_step", "get_capability_schemas", "get_nearby_entities"]) assert.ok(!names.includes(name));
    assert.equal(h.agent.task.summary, "");
  } finally { await h.close(); }
});

test("queries are replayed with matching assistant/tool roles", async () => {
  const h = await harness();
  try {
    const id = tool(h.llm, "get_inventory", {});
    tool(h.llm, "reply", { outcome: "answer", message: "Empty." });
    h.agent.submitUserMessage("owner", "Inventory?");
    await idle(h.agent);
    const messages = h.llm.requests[1]!.messages;
    assert.deepEqual(messages.map((m) => m.role), ["system", "assistant", "user", "assistant", "tool"]);
    const result = messages[4]!;
    assert.equal(result.role === "tool" && result.toolCallId, id);
    assert.deepEqual(JSON.parse(result.content!).value.items, []);
    assert.equal(h.actionInstructions.length, 0);
    assert.equal(h.inspector.listRounds().length, 2);
  } finally { await h.close(); }
});

test("compact coordinator replay keeps the latest result native, older replies plain, and inspector calls raw", async () => {
  const h = await harness(0, "compact");
  try {
    const id = tool(h.llm, "get_inventory", {});
    tool(h.llm, "reply", { outcome: "answer", message: "Your inventory is empty." });
    h.agent.submitUserMessage("owner", "Inventory?");
    await idle(h.agent);
    const next = h.llm.requests[1]!.messages;
    assert.deepEqual(next.map((m) => m.role), ["system", "assistant", "user", "assistant", "tool"]);
    assert.equal(next.at(-1)!.role, "tool");
    assert.deepEqual(JSON.parse(next.at(-1)!.content!).value.items, []);
    const executions = h.inspector.listRounds().flatMap((r) => h.inspector.getRound(r.id)!.toolExecutions);
    const raw = executions.find((execution) => execution.toolCallId === id)!;
    assert.equal(raw.arguments, "{}");
    assert.deepEqual(JSON.parse(raw.result!).value.items, []);
    tool(h.llm, "reply", { outcome: "answer", message: "Yes." });
    h.agent.submitUserMessage("owner", "Remember that?");
    await idle(h.agent);
    const latest = h.llm.requests[2]!.messages;
    assert.ok(latest.some((m) => m.role === "assistant" && m.content === "Your inventory is empty."));
    assert.ok(latest.some((m) => m.role === "assistant" && m.content?.includes("tool: get_inventory")));
    assert.ok(latest.every((m) => m.role !== "tool" && !(m.role === "assistant" && m.toolCalls?.length)));
    assert.equal((h.agent.state() as { toolReplayMode: string }).toolReplayMode, "compact");
  } finally { await h.close(); }
});

test("each coordinator call gets a fresh compact world snapshot while debug keeps the raw inventory", async () => {
  const h = await harness();
  try {
    let count = 1;
    h.world.getInventory = () => ({ items: [{ name: "oak_log", displayName: "Oak Log", type: 134, metadata: 0, count, slot: 36 }], selectedItem: null });
    h.llm.enqueue(() => {
      count = 2;
      return { message: { role: "assistant", content: null, toolCalls: [{ id: "read-inventory", name: "get_inventory", arguments: "{}" }] }, finishReason: "tool_calls" };
    });
    tool(h.llm, "reply", { outcome: "answer", message: "Two logs." });
    h.agent.submitUserMessage("owner", "Check inventory.");
    await idle(h.agent);
    assert.match(h.llm.requests[0]!.messages[0]!.content!, /Bot inventory: oak_log x1/);
    const latest = h.llm.requests[1]!;
    assert.match(latest.messages[0]!.content!, /Bot inventory: oak_log x2/);
    assert.doesNotMatch(latest.messages[0]!.content!, /oak_log x1|displayName|metadata|slot/);
    const raw = latest.trace!.contextSnapshot as { world: { inventory: { items: { slot: number; count: number }[] } } };
    assert.equal(raw.world.inventory.items[0]!.slot, 36);
    assert.equal(raw.world.inventory.items[0]!.count, 2);
  } finally { await h.close(); }
});

test("world observations sent to the coordinator use two decimals while inspector traces stay exact", async () => {
  const h = await harness();
  try {
    const rawSelf = { ...h.world.getSelf(), position: { x: 10.53869625851037, y: -60, z: 4.688901945948571 }, health: 14.833333969116211 };
    h.world.getSelf = () => rawSelf;
    tool(h.llm, "get_self", {});
    tool(h.llm, "reply", { outcome: "answer", message: "Observed." });
    h.agent.submitUserMessage("owner", "Where are you?");
    await idle(h.agent);
    const latest = h.llm.requests[1]!;
    assert.match(latest.messages[0]!.content!, /Bot position: \(10\.54, -60, 4\.69\)/);
    assert.match(latest.messages[0]!.content!, /Bot health: 14\.83/);
    const observed = JSON.parse(latest.messages.at(-1)!.content!).value;
    assert.equal(observed.position.x, 10.54);
    const execution = h.inspector.listRounds().flatMap((row) => h.inspector.getRound(row.id)!.toolExecutions).find((row) => row.name === "get_self")!;
    assert.equal(JSON.parse(execution.result!).value.position.x, 10.53869625851037);
    assert.equal(rawSelf.position.x, 10.53869625851037);
  } finally { await h.close(); }
});

test("planner creates indices, actioner gets context, completion and summary are separate", async () => {
  const h = await harness();
  try {
    plan(h.llm);
    tool(h.llm, "run_step", { step: 1, instruction: "Collect one more log." });
    tool(h.llm, "complete_step", { step: 1 });
    tool(h.llm, "refresh_summary", {});
    json(h.llm, { summary: "Collected one additional oak log." });
    tool(h.llm, "reply", { outcome: "success", message: "Done." });
    h.actions.push(actionSuccess());
    h.agent.submitUserMessage("owner", "Collect another log.");
    await idle(h.agent);
    assert.deepEqual(h.llm.requests.map((r) => r.trace?.phase), ["coordinator", "planner", "coordinator", "coordinator", "coordinator", "summary", "coordinator"]);
    assert.equal(h.llm.requests[1]!.tools, undefined);
    assert.equal(h.llm.requests[1]!.messages.at(-1)?.content, "Collect another log.");
    assert.equal(section(h.llm.requests[1]!.messages, "Instruction"), "Plan a small wood task.");
    assert.equal(section(h.llm.requests[1]!.messages, "Task Context"), "No plan yet.");
    assert.match(section(h.llm.requests[2]!.messages, "Task Context")!, /- \[ \] 1\. Collect a log — Inventory increases by one log relative to the initial state\./);
    assert.match(section(h.llm.requests[4]!.messages, "Task Context")!, /- \[x\] 1\. Collect a log/);
    assert.match(h.llm.requests[3]!.messages[0]!.content!, /Objective: Collect another log/);
    assert.match(h.llm.requests[3]!.messages[0]!.content!, /Step 1 reported success: One log collected/);
    assert.doesNotMatch(h.llm.requests[3]!.messages[0]!.content!, /dig-1|planVersion|"outcomes"/);
    const instruction = h.actionInstructions[0]!;
    assert.equal(instruction.step.step, 1);
    assert.equal(instruction.userObjective, "Collect another log.");
    assert.match(instruction.checklist, /1\. Collect a log/);
    assert.deepEqual(instruction.reports, []);
    assert.equal("world" in instruction, false); // The action agent receives a fresh World Context instead.
    assert.equal("planVersion" in instruction, false);
    const reportContext = JSON.parse(h.llm.requests[3]!.messages.at(-1)!.content!).value.report;
    assert.equal(reportContext.outcomes[0].capability, "dig");
    assert.equal(reportContext.outcomes[0].task, undefined);
    assert.deepEqual(reportContext.outcomes[0].result, h.agent.task.reports[1]!.report.outcomes[0]!.result);
    assert.equal(h.agent.task.steps[0]?.status, "done");
    const contents = await readFile(h.summary.path, "utf8");
    assert.match(contents, /- \[x\] 1\. Collect a log/);
    assert.match(contents, /Collected one additional oak log/);
    assert.match(contents, /Step 1 reported success: One log collected/);
    assert.deepEqual(h.replies, ["Done."]);
    assert.equal(h.llm.maxConcurrentRequests, 1);
  } finally { await h.close(); }
});

test("steps can be checked after later delegations without losing their reports", async () => {
  for (const replay of ["native", "compact"] as const) {
    const h = await harness(0, replay);
    try {
      tool(h.llm, "ask_planner", { instruction: "Plan the collection." });
      json(h.llm, { steps: [
        { title: "Find a tree", successCriteria: "A log position is known." },
        { title: "Break the log", successCriteria: "The target block is gone." },
        { title: "Collect the drop", successCriteria: "One new log is in inventory." },
      ] });
      for (const step of [1, 2, 3]) tool(h.llm, "run_step", { step, instruction: `Perform step ${step}.` });
      for (const step of [1, 2, 3]) tool(h.llm, "complete_step", { step });
      tool(h.llm, "reply", { outcome: "success", message: "Collected." });
      const reports = ["Found a log at (3, -60, 0).", "The log block is gone.", "Inventory increased from 0 to 1 log."]
        .map((message) => ({ ...actionSuccess(), message }));
      h.actions.push(...reports);
      h.agent.submitUserMessage("owner", "Collect one new log.");
      await idle(h.agent);

      assert.deepEqual(h.replies, ["Collected."]);
      assert.ok(h.agent.task.steps.every((step) => step.status === "done"));
      assert.equal(h.agent.task.currentStep, null);
      assert.deepEqual(Object.values(h.agent.task.reports).map((entry) => entry.report), reports);
      assert.deepEqual(h.actionInstructions[1]!.reports, [{ step: 1, status: "success", message: reports[0]!.message }]);
      assert.equal(h.actionInstructions[2]!.reports.length, 2);
      assert.match(h.actionInstructions[2]!.checklist, /1\. Find a tree[\s\S]*2\. Break the log[\s\S]*3\. Collect the drop/);

      const afterActions = section(h.llm.requests[5]!.messages, "Task Context")!;
      assert.match(afterActions, /Current step 3: Collect the drop/);
      for (const step of [1, 2, 3]) {
        assert.ok(afterActions.includes(`- [ ] ${step}.`)); // A claim never checks its own box.
        assert.ok(afterActions.includes(`Step ${step} reported success: ${reports[step - 1]!.message}`));
      }
      assert.doesNotMatch(afterActions, /dig-1|createdAt|"outcomes"|planVersion/);
      const afterFirstCheck = section(h.llm.requests[6]!.messages, "Task Context")!;
      assert.match(afterFirstCheck, /Current step 3: Collect the drop/);
      assert.match(afterFirstCheck, /- \[x\] 1\. Find a tree/);
      const contents = await readFile(h.summary.path, "utf8");
      assert.match(contents, /Step 1 reported success:[\s\S]*Step 3 reported success:/);

      // Stored reports own their data; changing a runner's returned object cannot rewrite the evidence.
      reports[0]!.message = "Changed runner object";
      assert.equal(h.agent.task.reports[1]!.report.message, "Found a log at (3, -60, 0).");
      tool(h.llm, "reply", { outcome: "answer", message: "Hello." });
      h.agent.submitUserMessage("owner", "Hello again.");
      await idle(h.agent);
      assert.deepEqual(h.agent.task.reports, {});
      assert.equal(h.agent.task.currentStep, null);
      assert.equal(section(h.llm.requests.at(-1)!.messages, "Task Context"), "No plan yet.");
    } finally { await h.close(); }
  }
});

test("a retry sees previous reports but its failure replaces only that step's earlier success", async () => {
  const h = await harness();
  try {
    tool(h.llm, "ask_planner", { instruction: "Plan two steps." });
    json(h.llm, { steps: [
      { title: "Collect wood", successCriteria: "One new log." },
      { title: "Locate stone", successCriteria: "A stone position is known." },
    ] });
    for (const step of [1, 2, 1]) tool(h.llm, "run_step", { step, instruction: "Inspect and perform the step." });
    tool(h.llm, "complete_step", { step: 1 });
    tool(h.llm, "complete_step", { step: 2 });
    tool(h.llm, "reply", { outcome: "failure", message: "Wood collection could not be confirmed." });
    h.actions.push(actionSuccess(), { ...actionSuccess(), message: "Located stone." }, { status: "failure", message: "The drop is gone.", outcomes: [] });
    h.agent.submitUserMessage("owner", "Collect wood and locate stone.");
    await idle(h.agent);
    assert.equal(h.actionInstructions[2]!.reports.length, 2);
    assert.equal(h.actionInstructions[2]!.reports[0]!.status, "success");
    assert.equal(h.agent.task.reports[1]!.report.status, "failure");
    assert.equal(h.agent.task.reports[2]!.report.message, "Located stone.");
    assert.equal(h.agent.task.steps[0]!.status, "blocked");
    assert.equal(h.agent.task.steps[1]!.status, "done");
    assert.equal(h.agent.task.currentStep, 1);
    assert.match(h.llm.requests[6]!.messages.at(-1)!.content!, /matching successful report/);
    const context = section(h.llm.requests.at(-1)!.messages, "Task Context")!;
    assert.match(context, /Step 1 reported failure: The drop is gone/);
    assert.doesNotMatch(context, /One log collected/);
  } finally { await h.close(); }
});

test("a delegation that throws invalidates its old successful report", async () => {
  const h = await harness();
  try {
    plan(h.llm);
    tool(h.llm, "run_step", { step: 1, instruction: "Collect the log." });
    tool(h.llm, "run_step", { step: 1, instruction: "Check after the world changed." });
    tool(h.llm, "complete_step", { step: 1 });
    tool(h.llm, "reply", { outcome: "failure", message: "Cannot confirm." });
    h.actions.push(actionSuccess()); // The second delegation throws: no scripted report.
    h.agent.submitUserMessage("owner", "Collect a log.");
    await idle(h.agent);
    assert.deepEqual(h.agent.task.reports, {});
    assert.equal(h.agent.task.steps[0]!.status, "blocked");
    assert.match(h.llm.requests[4]!.messages.at(-1)!.content!, /No scripted report/);
    assert.match(h.llm.requests.at(-1)!.messages.at(-1)!.content!, /matching successful report/);
  } finally { await h.close(); }
});

test("summary is iterative and isolated: only latest text in system, acknowledgements in history", async () => {
  const h = await harness();
  try {
    h.agent.task.summary = "Old important fact.";
    tool(h.llm, "refresh_summary", {});
    json(h.llm, { summary: "Old important fact. New fact." });
    tool(h.llm, "refresh_summary", {});
    json(h.llm, { summary: "Latest durable facts." });
    tool(h.llm, "reply", { outcome: "answer", message: "Ready." });
    h.agent.submitUserMessage("owner", "Remember this.");
    await idle(h.agent);
    assert.equal(h.llm.requests[1]!.trace?.phase, "summary");
    assert.match(h.llm.requests[1]!.messages[0]!.content!, /Old important fact/);
    const last = h.llm.requests.at(-1)!;
    assert.equal(section(last.messages, "Task Summary"), "Latest durable facts.");
    assert.equal(section(last.messages, "Task Context"), "No plan yet.");
    assert.doesNotMatch(last.messages[0]!.content!, /Old important fact|New fact|summaryVersion/);
    const history = JSON.stringify(last.messages.slice(1));
    assert.doesNotMatch(history, /Old important fact|New fact|Latest durable facts/);
    assert.match(history, /updated/);
    assert.equal(h.agent.task.summaryVersion, 2);
    assert.equal(h.inspector.listRounds().filter((r) => r.phase === "summary").length, 2);
  } finally { await h.close(); }
});

test("oversized summary is retried, never silently truncated", async () => {
  const h = await harness(1);
  try {
    tool(h.llm, "refresh_summary", {});
    json(h.llm, { summary: "x".repeat(501) });
    json(h.llm, { summary: "Short factual memory." });
    tool(h.llm, "reply", { outcome: "answer", message: "Ready." });
    h.agent.submitUserMessage("owner", "Remember.");
    await idle(h.agent);
    assert.equal(h.agent.task.summary, "Short factual memory.");
    assert.equal(h.llm.requests[2]!.messages.length, 1);
    assert.match(h.llm.requests[2]!.messages[0]!.content!, /Internal validation feedback/);
    assert.match(h.replies[0]!, /^\[Bot\] Invalid summary/);
  } finally { await h.close(); }
});

test("clearing the factual summary removes its section from the next system prompt", async () => {
  const h = await harness();
  try {
    h.agent.task.summary = "Previous fact.";
    tool(h.llm, "refresh_summary", {});
    json(h.llm, { summary: "" });
    tool(h.llm, "reply", { outcome: "answer", message: "Ready." });
    h.agent.submitUserMessage("owner", "Forget that fact.");
    await idle(h.agent);
    assert.equal(section(h.llm.requests[0]!.messages, "Task Summary"), "Previous fact.");
    assert.equal(section(h.llm.requests.at(-1)!.messages, "Task Summary"), undefined);
    assert.equal(section(h.llm.requests.at(-1)!.messages, "Task Context"), "No plan yet.");
  } finally { await h.close(); }
});

test("old JSON protocol and parallel calls are rejected without executing tools", async () => {
  const h = await harness(2);
  try {
    json(h.llm, { next: "reply", message: "Invalid old protocol" });
    h.llm.enqueue({ finishReason: "tool_calls", message: { role: "assistant", content: null, toolCalls: [
      { id: "a", name: "reply", arguments: '{"message":"No","outcome":"answer"}' },
      { id: "b", name: "refresh_summary", arguments: "{}" },
    ] } });
    tool(h.llm, "reply", { message: "Hello!", outcome: "answer" });
    h.agent.submitUserMessage("owner", "Hello?");
    await idle(h.agent);
    const retry = h.llm.requests[2]!.messages;
    assert.deepEqual(retry.map((m) => m.role), ["system", "assistant", "user"]);
    assert.match(retry[0]!.content!, /exactly one native tool call/);
    assert.equal(retry.at(-1)?.content, "Hello?");
    assert.equal(h.replies.filter((r) => !r.startsWith("[Bot]")).join(), "Hello!");
  } finally { await h.close(); }
});

test("failed reports and stale reports after replanning cannot check off a step", async () => {
  for (const replan of [false, true]) {
    const h = await harness();
    try {
      plan(h.llm);
      tool(h.llm, "run_step", { step: 1, instruction: "Do it." });
      if (replan) plan(h.llm, "New step");
      tool(h.llm, "complete_step", { step: 1 });
      tool(h.llm, "reply", { outcome: "failure", message: "Cannot confirm." });
      h.actions.push(replan ? actionSuccess() : { status: "failure", message: "NO_PATH", outcomes: [] });
      h.agent.submitUserMessage("owner", "Collect a log.");
      await idle(h.agent);
      assert.notEqual(h.agent.task.steps[0]?.status, "done");
      const result = h.llm.requests.at(-1)!.messages.at(-1)!;
      assert.match(result.content!, /matching successful report/);
      assert.equal(JSON.parse(result.content!).ok, false);
      const currentPlan = section(h.llm.requests.at(-1)!.messages, "Task Context")!;
      if (replan) {
        assert.match(currentPlan, /1\. New step/);
        assert.doesNotMatch(currentPlan, /1\. Collect a log|\[blocked\]|One log collected/);
        assert.deepEqual(h.agent.task.reports, {});
        assert.equal(h.agent.task.currentStep, null);
      } else {
        assert.match(currentPlan, /1\. Collect a log.*\[blocked\]/);
      }
    } finally { await h.close(); }
  }
});

test("execution needs a planner checklist and success needs verified completed steps", async () => {
  const h = await harness();
  try {
    tool(h.llm, "run_step", { step: 1, instruction: "Invented step" });
    plan(h.llm);
    tool(h.llm, "reply", { outcome: "success", message: "Not actually done" });
    tool(h.llm, "reply", { outcome: "needs_user", message: "Need help." });
    h.agent.submitUserMessage("owner", "Do work.");
    await idle(h.agent);
    assert.equal(h.actionInstructions.length, 0);
    assert.deepEqual(h.replies, ["Need help."]);
    assert.match(h.llm.requests.at(-1)!.messages.at(-1)!.content!, /verified completed checklist/);
  } finally { await h.close(); }
});

test("any player can ask for a plan and receive the coordinator's full tool catalog", async () => {
  const h = await harness();
  try {
    tool(h.llm, "ask_planner", { instruction: "Do work" });
    json(h.llm, { steps: [{ title: "Dig", successCriteria: "A block is gone." }] });
    tool(h.llm, "reply", { outcome: "needs_user", message: "Plan ready." });
    h.agent.submitUserMessage("guest", "Dig");
    await idle(h.agent);
    const names = h.llm.requests[0]!.tools!.map((t) => t.name);
    assert.ok(names.includes("ask_planner") && names.includes("run_step"));
    assert.equal(h.agent.task.steps.length, 1);
    assert.equal(h.actionInstructions.length, 0);
  } finally { await h.close(); }
});

test("coordinator retains the active request and atomic exchanges beyond 20 messages", async () => {
  const h = await harness();
  try {
    plan(h.llm);
    for (let i = 0; i < 15; i++) tool(h.llm, "get_self", {});
    tool(h.llm, "reply", { outcome: "answer", message: "Checked." });
    h.agent.submitUserMessage("owner", "Keep this objective.");
    await idle(h.agent);
    for (const request of h.llm.requests) { assertProtocol(request.messages); }
    const last = h.llm.requests.at(-1)!.messages;
    assert.match(section(last, "Task Context")!, /1\. Collect a log/);
    assert.match(last[0]!.content!, /Objective: Keep this objective/);
    assert.doesNotMatch(last[0]!.content!, /historyOmitted|source|planVersion/);
    assert.equal(last.find((m) => m.role === "user")?.content, "Keep this objective.");
  } finally { await h.close(); }
});

test("only validated plans enter Task Context and a new player request resets it", async () => {
  const h = await harness(1);
  try {
    tool(h.llm, "ask_planner", { instruction: "Create a wood checklist." });
    json(h.llm, { steps: [] });
    json(h.llm, { steps: [{ title: "Collect wood", successCriteria: "One additional log in inventory." }] });
    tool(h.llm, "reply", { outcome: "needs_user", message: "Plan ready." });
    h.agent.submitUserMessage("owner", "Collect some wood.");
    await idle(h.agent);
    assert.equal(section(h.llm.requests[1]!.messages, "Task Context"), "No plan yet.");
    assert.equal(section(h.llm.requests[2]!.messages, "Task Context"), "No plan yet.");
    assert.match(section(h.llm.requests[3]!.messages, "Task Context")!, /1\. Collect wood/);
    tool(h.llm, "reply", { outcome: "answer", message: "Hello." });
    h.agent.submitUserMessage("owner", "Hello again.");
    await idle(h.agent);
    assert.equal(section(h.llm.requests.at(-1)!.messages, "Task Context"), "No plan yet.");
    assert.doesNotMatch(h.llm.requests.at(-1)!.messages[0]!.content!, /Collect wood|Hello again/);
  } finally { await h.close(); }
});

test("planner gets real user/assistant chat, not the coordinator's tool transcript", async () => {
  const h = await harness();
  try {
    tool(h.llm, "reply", { outcome: "answer", message: "I will remember blue." });
    h.agent.submitUserMessage("owner", "The code is blue.");
    await idle(h.agent);
    plan(h.llm);
    tool(h.llm, "reply", { outcome: "needs_user", message: "Plan ready." });
    h.agent.submitUserMessage("owner", "Use that code for the task.");
    await idle(h.agent);
    const planner = h.llm.requests.find((r) => r.trace?.phase === "planner")!;
    assert.match(planner.messages[1]!.content!, /Previous conversation summary: empty/);
    assert.deepEqual(planner.messages.slice(2).map((m) => m.content), ["The code is blue.", "I will remember blue.", "Use that code for the task."]);
    assertProtocol(h.llm.requests[1]!.messages);
  } finally { await h.close(); }
});

test("stop during planning aborts and resume sees the interrupted exchange", async () => {
  const h = await harness();
  try {
    tool(h.llm, "ask_planner", { instruction: "Plan work" });
    h.llm.enqueueDeferred();
    h.agent.submitUserMessage("owner", "Collect wood.");
    await until(() => h.llm.requests.length === 2);
    h.agent.submitUserMessage("owner", "Ignored while busy");
    await h.agent.requestStop("owner");
    assert.equal((h.agent.state() as { mode: string }).mode, "stopped");
    tool(h.llm, "reply", { outcome: "answer", message: "Resumed." });
    h.agent.requestResume("owner");
    await idle(h.agent);
    const messages = h.llm.requests[2]!.messages;
    assertProtocol(messages);
    assert.equal(JSON.parse(messages.at(-1)!.content!).ok, false);
    assert.doesNotMatch(JSON.stringify(messages), /Ignored while busy/);
  } finally { await h.close(); }
});

let callId = 0;
function tool(llm: FakeLLMClient, name: string, args: unknown): string {
  const id = `call-${++callId}`;
  llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }, finishReason: "tool_calls" });
  return id;
}
function json(llm: FakeLLMClient, value: unknown): void { llm.enqueue({ message: { role: "assistant", content: JSON.stringify(value) }, finishReason: "stop" }); }
function plan(llm: FakeLLMClient, title = "Collect a log"): void {
  tool(llm, "ask_planner", { instruction: "Plan a small wood task." });
  json(llm, { steps: [{ title, successCriteria: "Inventory increases by one log relative to the initial state." }] });
}
function actionSuccess(): DelegatedActionReport {
  return { status: "success", message: "One log collected.", outcomes: [{ task: { id: "dig-1", createdAt: 0, capability: "dig", input: {} }, result: success({ block: "oak_log" }) }] };
}
function section(messages: readonly LLMMessage[], heading: string): string | undefined {
  const text = messages[0]!.content!;
  return text.split(`## ${heading}\n`)[1]?.split(/\n## /)[0]?.trim();
}
function assertProtocol(messages: readonly LLMMessage[]): void {
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "assistant");
  assert.match(messages[1]!.content!, /Previous conversation summary: empty/);
  assert.equal(messages.filter((m) => m.content?.startsWith("Previous conversation summary:")).length, 1);
  let pending: string[] = [];
  for (const message of messages.slice(1)) {
    if (message.role === "tool") assert.equal(message.toolCallId, pending.shift());
    else { assert.equal(pending.length, 0); if (message.role === "assistant") pending = message.toolCalls?.map((c) => c.id) ?? []; }
  }
  assert.equal(pending.length, 0);
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("Workflow did not reach expected state.");
}
async function idle(agent: WorkflowAgent): Promise<void> { await until(() => (agent.state() as { mode: string }).mode === "idle"); }
async function harness(maxRetries = 0, toolReplayMode: "native" | "compact" = "native", contextBudget?: ContextBudget) {
  const root = await mkdtemp(join(tmpdir(), "minecraft-workflow-test-"));
  const llm = new FakeLLMClient();
  const inspector = new AgentInspector(100);
  const replies: string[] = [], actions: DelegatedActionReport[] = [], actionInstructions: ActionDelegation[] = [];
  const actionAgent = {
    state: () => ({ mode: "idle" }),
    runDelegatedStep: async (instruction: ActionDelegation) => {
      actionInstructions.push(instruction);
      const report = actions.shift();
      if (!report) throw new Error("No scripted report.");
      return report;
    },
    requestStop: async () => undefined, shutdown: async () => undefined,
  } as unknown as ActionAgent;
  const world = {
    getSelf: () => ({ position: { x: 0, y: 0, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20, onGround: true }),
    getInventory: () => ({ items: [], selectedItem: null }),
  } as unknown as WorldQueries;
  const summary = new WorkflowSummaryFile("test", root);
  const agent = new WorkflowAgent({
    llm, actionAgent, world, inspector, queries: createDefaultWorldQueryRegistry(world),
    landmarks: { pinned: () => [] } as unknown as LandmarkMemory,
    prompts: {
      contextSummary: PromptTemplate.fromString("context-summary", "Compress {{summary_input}} under {{max_chars}} characters."),
      coordinator: PromptTemplate.fromString("coordinator", "Coordinator\n## Task Context\n{{task_context}}\n{{task_summary_section}}\n## World Context\n{{world_context}}"),
      planner: PromptTemplate.fromString("planner", "Planner\n## Task Context\n{{task_context}}\n{{task_summary_section}}\n## Instruction\n{{instruction}}\n## World Context\n{{world_context}}"),
      actioner: PromptTemplate.fromString("actioner", "Actioner {{task_context}}"),
      summary: PromptTemplate.fromString("summary", "Summary limit {{max_chars}}\n{{summary_input}}"),
      conversationSummary: PromptTemplate.fromString("conversation-summary", "Previous conversation summary: {{summary}}"),
    },
    temperature: 0, maxTokens: 4096, maxRetries,
    toolReplayMode, contextBudget,
    summaryFile: summary, respond: async (message) => { replies.push(message); },
  });
  return { agent, llm, inspector, replies, actions, actionInstructions, summary, world,
    close: async () => { await agent.shutdown(); await rm(root, { recursive: true, force: true }); },
  };
}

test("coordinator and planner retry malformed transport responses without repeating side effects", async () => {
  const h = await harness(1);
  try {
    h.llm.enqueue(() => { throw new LLMError("INVALID_RESPONSE", "Empty response"); });
    tool(h.llm, "ask_planner", { instruction: "Plan one log" });
    h.llm.enqueue(() => { throw new LLMError("INVALID_RESPONSE", "Malformed JSON transport"); });
    json(h.llm, { steps: [{ title: "Collect one log", successCriteria: "One new log in inventory" }] });
    tool(h.llm, "reply", { outcome: "answer", message: "Plan ready" });
    h.agent.submitUserMessage("owner", "Plan collecting wood");
    await idle(h.agent);
    assert.equal(h.agent.task.steps.length, 1);
    assert.equal(h.actionInstructions.length, 0);
    assert.equal(h.inspector.listRounds().filter((r) => r.status === "invalid_response").length, 2);
    assert.equal(h.replies.at(-1), "Plan ready");
  } finally { await h.close(); }
});

test("coordinator compression retains the request, then planner receives its summary and chronological chat", async () => {
  const h = await harness(0, "native", { charsPerToken: 3, compactAtTokens: 7000, targetTokens: 4000, summaryMaxChars: 300 });
  let observations = 0;
  try {
    for (let i = 0; i < 100; i++) h.llm.enqueue((request) => {
      if (request.trace?.phase === "context_summary") return { message: { role: "assistant", content: '{"summary":"Read the bot state repeatedly. No new log collected."}' }, finishReason: "stop" };
      if (request.trace?.phase === "planner") return { message: { role: "assistant", content: '{"steps":[{"title":"Collect a new log","successCriteria":"Inventory increases by one"}]}' }, finishReason: "stop" };
      const n = observations++;
      const name = n < 40 ? "get_self" : n === 40 ? "ask_planner" : "reply";
      const args = n < 40 ? {} : n === 40 ? { instruction: "Plan the new log" } : { message: "Plan ready", outcome: "answer" };
      return { message: { role: "assistant", content: "Inspecting the current state.", toolCalls: [{ id: "call-" + i, name, arguments: JSON.stringify(args) }] }, finishReason: "tool_calls" };
    });
    h.agent.submitUserMessage("owner", "Collect one NEW log");
    await idle(h.agent);
    assert.ok(h.llm.requests.some((r) => r.trace?.phase === "context_summary"));
    const planner = h.llm.requests.find((r) => r.trace?.phase === "planner")!;
    assert.ok(planner);
    assert.match(planner.messages[1]!.content!, /No new log collected/);
    assert.equal(planner.messages.at(-1)!.content, "Collect one NEW log");
    assert.equal(h.replies.at(-1), "Plan ready");
  } finally { await h.close(); }
});
