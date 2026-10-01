import assert from "node:assert/strict";
import test from "node:test";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import type { InspectorRound, InspectorToolExecution } from "../../../src/debug/InspectorTypes";
import type { LLMRequestTrace } from "../../../src/llm/LLMClient";

test("actioner cards show the player request, delegated step, capability and actual failure", () => {
  const result = { task: { capability: "goto" }, result: { ok: false, error: { code: "NO_PATH", message: "Target unreachable." } } };
  const round = snapshot({
    phase: "actioner_review",
    contextSnapshot: { objective: JSON.stringify({
      userObjective: "Collect one additional log", step: { step: 2, title: "Reach the log" },
    }) },
  }, { name: "continue_plan", result: JSON.stringify(result), ok: true });
  assert.equal(round.requestTitle, "Collect one additional log");
  assert.equal(round.agentLabel, "Actioner");
  assert.equal(round.stepLabel, "Step 2 — Reach the log");
  assert.equal(round.activity, "continue_plan → goto");
  assert.equal(round.outcome, "Failed: NO_PATH — Target unreachable.");
  assert.equal(round.failed, true); // Even when the wrapper incorrectly labels the execution successful.
});

test("coordinator cards distinguish successful tool invocation from a failed delegated report", () => {
  const round = snapshot({
    phase: "coordinator",
    contextSnapshot: { task: { objective: "Build a crafting table", steps: [{ step: 1, title: "Collect wood" }] } },
  }, {
    name: "run_step", arguments: '{"step":1}', ok: true,
    result: JSON.stringify({ ok: true, value: { report: { status: "failure", message: "No reachable tree." } } }),
  });
  assert.equal(round.stepLabel, "Step 1 — Collect wood");
  assert.equal(round.activity, "run_step → Step 1");
  assert.equal(round.outcome, "Failed — No reachable tree.");
  assert.equal(round.failed, true);
});

test("cards highlight failed actions even in a success report after recovery", () => {
  const round = snapshot({ phase: "coordinator" }, {
    name: "run_step", ok: true,
    result: JSON.stringify({ ok: true, value: { report: {
      status: "success", message: "Alternative route worked.",
      outcomes: [{ result: { ok: false, error: { code: "TIMEOUT", message: "First route timed out." } } }],
    } } }),
  });
  assert.equal(round.failed, true);
  assert.match(round.outcome, /TIMEOUT/);
});

test("finish_step displays its concise report without confusing needs_user with execution failure", () => {
  for (const status of ["success", "failure", "needs_user"]) {
    const round = snapshot({ phase: "actioner_planning" }, {
      name: "finish_step", arguments: JSON.stringify({ status, message: "Observed facts." }), ok: true,
      result: JSON.stringify({ ok: true, value: { status, message: "Observed facts." } }),
    });
    assert.equal(round.failed, status === "failure");
    assert.match(round.outcome, /Observed facts\./);
    assert.equal(round.agentLabel, "Actioner");
  }
});

test("a failure reply is not presented as success merely because it was sent", () => {
  const round = snapshot({ phase: "coordinator" }, {
    name: "reply", arguments: '{"outcome":"failure","message":"No path."}', ok: true,
    result: '{"ok":true,"value":{"sent":true,"outcome":"failure"}}',
  });
  assert.equal(round.failed, true);
  assert.equal(round.outcome, "Failed — No path.");
});

test("planner cards present a checklist count rather than raw output JSON", () => {
  const round = snapshot({
    phase: "planner", contextSnapshot: { task: { objective: "Collect wood" }, instruction: "Plan one additional log." },
  }, undefined, { steps: [{ title: "Find tree" }, { title: "Collect log" }] });
  assert.equal(round.requestTitle, "Collect wood");
  assert.equal(round.stepLabel, "Plan one additional log.");
  assert.equal(round.activity, "Create checklist");
  assert.equal(round.outcome, "Checklist created — 2 steps");
  assert.equal(round.failed, false);
});

test("cards flag parsing, provider and token limit errors and show their cause", () => {
  for (const status of ["invalid_response", "error", "token_limit_discarded", "tool_round_limit"] as const) {
    const inspector = new AgentInspector(5, "errors");
    const current = trace();
    inspector.beginRound(current);
    inspector.annotate(current, { validationError: "Missing required field." });
    const round = inspector.finalizeRound(current, status)!;
    assert.equal(round.failed, true);
    assert.equal(round.outcome, "Failed — Missing required field.");
  }
  const inspector = new AgentInspector(5, "length");
  inspector.beginRound(trace());
  inspector.recordResponse(trace(), { message: { role: "assistant", content: "partial" }, finishReason: "length" });
  const round = inspector.finalizeRound(trace(), "completed")!;
  assert.equal(round.failed, true);
  assert.match(round.outcome, /token limit/);
});

test("plan previews list capabilities and never mutate exact payloads", () => {
  const input = { tasks: [{ capability: "goto", input: { x: 1.123456 } }, { capability: "dig", input: {} }] };
  const inspector = new AgentInspector(5, "immutable");
  const current = trace();
  const argumentsText = JSON.stringify(input);
  inspector.beginRound(current);
  inspector.recordRequest(current, { model: "qwen", messages: [{ role: "user", content: "collect wood" }] });
  inspector.recordToolStarted(current, { toolCallId: "a", name: "set_plan", arguments: argumentsText });
  inspector.recordToolCompleted(current, {
    toolCallId: "a", name: "set_plan", arguments: argumentsText, ok: true,
    result: JSON.stringify({ ok: true, value: { remainingPlan: input.tasks } }),
  });
  const round = inspector.finalizeRound(current, "completed")!;
  assert.equal(round.activity, "set_plan → goto → dig");
  assert.equal(round.outcome, "Plan saved — 2 actions");
  assert.equal(round.requestTitle, "collect wood");
  assert.equal(round.toolExecutions[0]?.arguments, argumentsText);
  assert.equal(input.tasks[0]?.input.x, 1.123456);
  const summary = inspector.listRounds()[0]!;
  assert.equal(summary.activity, round.activity);
  assert.equal(summary.requestTitle, round.requestTitle);
  assert.equal("toolExecutions" in summary, false);
  assert.equal("requestBody" in summary, false);
});

test("invalid JSON arguments remain available without breaking the card summary", () => {
  const round = snapshot({}, { name: "set_plan", arguments: '{"tasks":', ok: false, result: '{"ok":false,"error":{"message":"Invalid JSON."}}' });
  assert.equal(round.activity, "set_plan");
  assert.equal(round.failed, true);
  assert.match(round.outcome, /Invalid JSON/);
});

function snapshot(
  overrides: Partial<LLMRequestTrace>,
  execution?: Partial<InspectorToolExecution> & { name: string },
  decision?: unknown,
): InspectorRound {
  const inspector = new AgentInspector(5, "display");
  const current = trace(overrides);
  inspector.beginRound(current);
  if (execution) {
    const tool = { toolCallId: "call", arguments: "{}", ...execution };
    inspector.recordResponse(current, {
      message: { role: "assistant", content: null, toolCalls: [{ id: tool.toolCallId, name: tool.name, arguments: tool.arguments }] },
      finishReason: "tool_calls",
    });
    inspector.recordToolCompleted(current, tool);
  }
  if (decision) inspector.annotate(current, { decision });
  return inspector.finalizeRound(current, "completed")!;
}

function trace(overrides: Partial<LLMRequestTrace> = {}): LLMRequestTrace {
  return { generationId: 1, phase: "coordinator", reflection: 0, round: 0, attempt: 0, wakeType: "coordinator", permission: "coordination", ...overrides };
}
