import assert from "node:assert/strict";
import test from "node:test";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { loadAgentConfig } from "../../../src/agent/AgentConfig";

test("inspector snapshots are deep-cloned and frozen on finalize", () => {
  const inspector = new AgentInspector(3, "session");
  const trace = {
    generationId: 1,
    round: 0,
    wakeType: "user_message",
    permission: "acting",
  };
  inspector.beginRound(trace);
  const body = {
    model: "qwen",
    messages: [{ role: "user", content: "hello" }],
    apiKey: "secret-key",
    authorization: "Bearer secret",
  };
  inspector.recordRequest(trace, body);
  body.messages[0]!.content = "mutated";
  inspector.recordResponse(
    trace,
    {
      message: { role: "assistant", content: "ok" },
      finishReason: "stop",
      usage: { totalTokens: 9 },
    },
    { choices: [{ message: { content: "ok" } }], apiKey: "raw-secret" },
  );
  const snapshot = inspector.finalizeRound(1, 0, "completed");
  assert.ok(snapshot);
  assert.equal(
    (snapshot.request?.messages[0] as { content?: string } | undefined)
      ?.content,
    "hello",
  );
  assert.equal("apiKey" in (snapshot.requestBody ?? {}), false);
  assert.equal("authorization" in (snapshot.requestBody ?? {}), false);
  assert.throws(() => {
    (snapshot as { status: string }).status = "error";
  });
  assert.equal(inspector.getRound(snapshot.id)?.status, "completed");
});

test("request, response, and tool results associate on the same round", () => {
  const inspector = new AgentInspector(5, "session");
  inspector.beginRound({
    generationId: 2,
    round: 1,
    wakeType: "user_message",
    permission: "acting",
  });
  inspector.recordRequest(
    {
      generationId: 2,
      round: 1,
      wakeType: "user_message",
      permission: "acting",
    },
    {
      model: "qwen",
      messages: [],
      tools: [{ type: "function", function: { name: "enqueue_tasks" } }],
    },
  );
  inspector.recordResponse(
    {
      generationId: 2,
      round: 1,
      wakeType: "user_message",
      permission: "acting",
    },
    {
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "enqueue_tasks",
            arguments: '{"tasks":"[...]"}',
          },
        ],
      },
      finishReason: "tool_calls",
    },
  );
  inspector.recordToolStarted(2, 1, {
    toolCallId: "call_1",
    name: "enqueue_tasks",
    arguments: '{"tasks":"[...]"}',
  });
  inspector.recordToolCompleted(2, 1, {
    toolCallId: "call_1",
    name: "enqueue_tasks",
    arguments: '{"tasks":"[...]"}',
    result: '{"ok":false}',
    ok: false,
  });
  const snapshot = inspector.finalizeRound(2, 1, "completed");
  assert.equal(snapshot?.toolExecutions[0]?.arguments, '{"tasks":"[...]"}');
  assert.equal(snapshot?.toolExecutions[0]?.ok, false);
  assert.equal(snapshot?.response?.toolCalls.length, 1);
});

test("old finalized snapshots stay unchanged when newer rounds arrive", () => {
  const inspector = new AgentInspector(2, "session");
  for (const generationId of [1, 2, 3]) {
    const trace = {
      generationId,
      round: 0,
      wakeType: "user_message",
      permission: "acting",
    };
    inspector.beginRound(trace);
    inspector.recordRequest(trace, {
      model: "qwen",
      messages: [{ role: "user", content: `g${generationId}` }],
    });
    inspector.recordResponse(trace, {
      message: { role: "assistant", content: `r${generationId}` },
      finishReason: "stop",
    });
    inspector.finalizeRound(generationId, 0, "completed");
  }
  const listed = inspector.listRounds();
  assert.equal(listed.length, 2);
  assert.equal(listed[0]?.generationId, 2);
  assert.equal(listed[1]?.generationId, 3);
  const old = inspector.getRound(listed[0]!.id);
  assert.equal(old?.response?.content, "r2");
  assert.equal(inspector.status().latestRoundId, listed[1]?.id);
});

test("list summaries omit full prompts and request bodies", () => {
  const inspector = new AgentInspector(5, "session");
  const trace = {
    generationId: 1,
    round: 0,
    wakeType: "user_message",
    permission: "acting",
  };
  inspector.beginRound(trace);
  inspector.recordRequest(trace, {
    model: "qwen",
    messages: [{ role: "system", content: "very long system prompt" }],
  });
  inspector.finalizeRound(1, 0, "completed");
  const summary = inspector.listRounds()[0]!;
  assert.equal("request" in summary, false);
  assert.equal("requestBody" in summary, false);
  assert.equal("messages" in summary, false);
});

test("inspector config defaults and rejects non-localhost hosts", () => {
  const config = loadAgentConfig({});
  assert.equal(config.inspectorEnabled, true);
  assert.equal(config.inspectorHost, "127.0.0.1");
  assert.equal(config.inspectorPort, 3001);
  assert.equal(config.inspectorMaxRounds, 30);
  assert.throws(() =>
    loadAgentConfig({
      AGENT_INSPECTOR_HOST: "0.0.0.0",
    }),
  );
});
