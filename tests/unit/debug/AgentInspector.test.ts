import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentConfig } from "../../../src/agent/AgentConfig";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import type { LLMRequestTrace } from "../../../src/llm/LLMClient";

test("inspector snapshots are deep-cloned and frozen on finalize", () => {
  const inspector = new AgentInspector(3, "session");
  const body = {
    model: "qwen",
    messages: [{ role: "user", content: "hello" }],
    apiKey: "secret-key",
    authorization: "Bearer secret",
  };
  inspector.beginRound(trace());
  inspector.recordRequest(trace(), body);
  body.messages[0]!.content = "mutated";
  inspector.recordResponse(
    trace(),
    {
      message: { role: "assistant", content: "ok" },
      finishReason: "stop",
      usage: { totalTokens: 9 },
    },
    { choices: [{ message: { content: "ok" } }], apiKey: "raw-secret" },
  );
  const snapshot = inspector.finalizeRound(trace(), "completed");
  assert.ok(snapshot);
  assert.equal(
    (snapshot.request?.messages[0] as { content?: string } | undefined)
      ?.content,
    "hello",
  );
  assert.equal("apiKey" in (snapshot.requestBody ?? {}), false);
  assert.throws(() => {
    (snapshot as { status: string }).status = "error";
  });
});

test("request, response, and tool results associate on the same round", () => {
  const inspector = new AgentInspector(5, "session");
  const current = trace({
    generationId: 2,
    phase: "planning",
    reflection: 1,
    round: 1,
  });
  inspector.beginRound(current);
  inspector.recordRequest(current, {
    model: "qwen",
    messages: [],
    tools: [{ type: "function", function: { name: "set_plan" } }],
  });
  inspector.recordResponse(current, {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call_1",
          name: "set_plan",
          arguments: '{"tasks":[]}',
        },
      ],
    },
    finishReason: "tool_calls",
  });
  inspector.recordToolStarted(current, {
    toolCallId: "call_1",
    name: "set_plan",
    arguments: '{"tasks":[]}',
  });
  inspector.recordToolCompleted(current, {
    toolCallId: "call_1",
    name: "set_plan",
    arguments: '{"tasks":[]}',
    result: '{"ok":true}',
    ok: true,
  });
  inspector.annotate(current, {
    memoryBefore: "old",
    memoryAfter: "new",
    decision: { type: "set_plan" },
  });
  const snapshot = inspector.finalizeRound(current, "completed");
  assert.equal(snapshot?.memoryBefore, "old");
  assert.equal(snapshot?.memoryAfter, "new");
  assert.equal(snapshot?.toolExecutions[0]?.ok, true);
});

test("old finalized snapshots stay unchanged when newer rounds arrive", () => {
  const inspector = new AgentInspector(2, "session");
  for (const generationId of [1, 2, 3]) {
    const current = trace({ generationId, phase: "review" });
    inspector.beginRound(current);
    inspector.recordRequest(current, {
      model: "qwen",
      messages: [{ role: "user", content: `g${generationId}` }],
    });
    inspector.recordResponse(current, {
      message: { role: "assistant", content: `r${generationId}` },
      finishReason: "stop",
    });
    inspector.finalizeRound(current, "completed");
  }
  const listed = inspector.listRounds();
  assert.equal(listed.length, 2);
  assert.equal(listed[0]?.generationId, 2);
  assert.equal(inspector.getRound(listed[0]!.id)?.response?.content, "r2");
});

test("nested planner and coordinator rounds list in start order", async () => {
  const inspector = new AgentInspector(3, "session");
  const coordinator = trace({ phase: "coordinator", reflection: 1 });
  const planner = trace({ phase: "planner", reflection: 2 });
  inspector.beginRound(coordinator);
  await new Promise((resolve) => setTimeout(resolve, 5));
  inspector.beginRound(planner);
  inspector.finalizeRound(planner, "completed");
  inspector.finalizeRound(coordinator, "completed");
  assert.deepEqual(inspector.listRounds().map((round) => round.phase), ["coordinator", "planner"]);
  assert.equal(inspector.status().latestRoundId, inspector.listRounds()[1]!.id);
});

test("invalid attempts stay visible and do not mutate a previous snapshot", () => {
  const inspector = new AgentInspector(5, "session");
  const first = trace({ attempt: 0 });
  inspector.beginRound(first);
  const firstSnapshot = inspector.finalizeRound(first, "invalid_response");
  const second = trace({ attempt: 1 });
  inspector.beginRound(second);
  inspector.annotate(second, { validationError: "tasks must be an array" });
  inspector.finalizeRound(second, "completed");
  assert.equal(firstSnapshot?.status, "invalid_response");
  assert.equal(inspector.getRound(firstSnapshot!.id)?.status, "invalid_response");
  assert.equal(inspector.listRounds()[1]?.status, "completed");
});

test("inspector config includes sequential defaults", () => {
  const config = loadAgentConfig({});
  assert.equal(config.memoryMaxChars, 500);
  assert.equal(config.responseMaxRetries, 8);
  assert.throws(() =>
    loadAgentConfig({
      AGENT_INSPECTOR_HOST: "0.0.0.0",
    }),
  );
});

function trace(
  overrides: Partial<LLMRequestTrace> = {},
): LLMRequestTrace {
  return {
    generationId: 1,
    phase: "planning",
    reflection: 0,
    round: 0,
    attempt: 0,
    wakeType: "reflection",
    permission: "action",
    ...overrides,
  };
}
