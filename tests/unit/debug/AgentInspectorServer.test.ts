import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { startAgentInspectorServer } from "../../../src/debug/AgentInspectorServer";
import { resolveInspectorUiRoot } from "../../../src/debug/resolveInspectorUiRoot";
import type { LLMRequestTrace } from "../../../src/llm/LLMClient";
import { writeTrace } from "../../../src/TraceLog";

test("inspector HTTP routes serve compact list, detail, UI, and status", async () => {
  const inspector = new AgentInspector(10, "http-session");
  const current = inspectorTrace({
    generationId: 7,
    phase: "actioner",
    wakeType: "user_message",
  });
  inspector.beginRound(current);
  inspector.recordRequest(current, {
    model: "qwen",
    messages: [{ role: "user", content: "build a table" }],
    tools: [],
  });
  inspector.recordResponse(current, {
    message: { role: "assistant", content: "ok" },
    finishReason: "stop",
    usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
  });
  const snapshot = inspector.finalizeRound(current, "completed");
  assert.ok(snapshot);

  const server = await startAgentInspectorServer({
    inspector,
    host: "127.0.0.1",
    port: 0,
    uiRoot: resolveInspectorUiRoot(),
    getAgentState: () => ({ generationId: 7, thinking: false }),
  });

  try {
    const status = await fetchJson(`${server.url}/api/status`);
    assert.equal(status.sessionId, "http-session");
    assert.equal(status.agent.generationId, 7);

    const list = await fetchJson(`${server.url}/api/rounds`);
    assert.equal(list.rounds.length, 1);
    assert.equal(list.rounds[0].id, snapshot.id);
    assert.equal(list.rounds[0].callIndex, 1);
    assert.equal(list.rounds[0].requestTitle, "build a table");
    assert.equal("requestBody" in list.rounds[0], false);

    const detail = await fetchJson(
      `${server.url}/api/rounds/${encodeURIComponent(snapshot.id)}`,
    );
    assert.equal(detail.request.messages[0].content, "build a table");
    assert.equal(detail.response.usage.totalTokens, 4);
    assert.equal(detail.callIndex, list.rounds[0].callIndex);
    assert.equal(detail.requestTitle, list.rounds[0].requestTitle);

    const missing = await fetch(`${server.url}/api/rounds/missing`);
    assert.equal(missing.status, 404);

    const html = await fetch(`${server.url}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Agent LLM Inspector/);

    const css = await fetch(`${server.url}/inspector.css`);
    assert.equal(css.status, 200);

    writeTrace("action.task_started", { taskId: "collect", capability: "collect_resource", actionNumber: 42, toolCallId: "native" });
    writeTrace("collect.event", { taskId: "collect", event: "operation_started", index: 1, operation: "dig", args: { position: { x: 1, y: 2, z: 3 } } });
    writeTrace("collect.event", { taskId: "collect", event: "operation_failed", index: 1, error: "stop", durationMs: 20 });
    const operations = await fetchJson(`${server.url}/api/collections/42?after=0&limit=1`);
    assert.equal(operations.operations[0].status, "failed"); assert.equal(operations.toolCallId, "native");
    assert.equal((await fetch(`${server.url}/api/collections/42?limit=99999`)).status, 400);
    assert.equal((await fetch(`${server.url}/api/collections/404`)).status, 404);
    assert.equal("collections" in detail, false, "Details are never duplicated in every round");

    const post = await fetch(`${server.url}/api/rounds`, { method: "POST" });
    assert.equal(post.status, 405);

    const forbidden = await fetch(`${server.url}/api/rounds/clear`, {
      method: "POST",
      headers: { origin: "http://example.com" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await fetchJson(`${server.url}/api/rounds`)).rounds.length, 1);

    const cleared = await fetch(`${server.url}/api/rounds/clear`, {
      method: "POST",
      headers: { origin: server.url },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { cleared: 1, sessionId: "http-session" });
    assert.equal((await fetchJson(`${server.url}/api/rounds`)).rounds.length, 0);
    assert.equal((await fetch(`${server.url}/api/rounds/${snapshot.id}`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/collections/42`)).status, 404);
  } finally {
    await server.close();
  }
});

test("occupied inspector port does not throw beyond EADDRINUSE", async () => {
  const blocker = createServer((_request, response) => {
    response.end("busy");
  });
  await new Promise<void>((resolve) => {
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const inspector = new AgentInspector(5, "busy-session");

  await assert.rejects(
    () =>
      startAgentInspectorServer({
        inspector,
        host: "127.0.0.1",
        port,
        uiRoot: resolveInspectorUiRoot(),
      }),
    (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
  );

  await new Promise<void>((resolve, reject) => {
    blocker.close((error) => (error ? reject(error) : resolve()));
  });
});

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.json();
}

function inspectorTrace(
  overrides: Partial<LLMRequestTrace> = {},
): LLMRequestTrace {
  return {
    generationId: 1,
    phase: "actioner",
    reflection: 0,
    round: 0,
    attempt: 0,
    wakeType: "reflection",
    permission: "action",
    ...overrides,
  };
}
