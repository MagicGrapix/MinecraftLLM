import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { summarizeTrace } from "../../e2e/Statistics";
import { renderReport } from "../../e2e/Report";
import type { TraceEvent } from "../../e2e/types";

const event = (time: number, name: string, data: unknown): TraceEvent => ({ timestamp: new Date(time).toISOString(), event: name, data });

test("nested tools retain start order, failures and per-tool counts without duplicate finalization", () => {
  const trace = [
    event(100, "workflow.accepted", {}),
    event(110, "tool.started", { actionNumber: 1, tool: "run_step", context: { agent: "coordinator" } }),
    event(150, "tool.started", { actionNumber: 2, tool: "dig", context: { agent: "actioner" } }),
    event(170, "tool.completed", { actionNumber: 2, tool: "dig", ok: false }),
    event(171, "tool.completed", { actionNumber: 2, tool: "dig", ok: false }),
    event(200, "tool.completed", { actionNumber: 1, tool: "run_step", ok: true }),
    event(210, "tool.started", { actionNumber: 3, tool: "goto" }),
  ];
  const result = summarizeTrace(trace);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.failedTools, 1);
  assert.equal(result.tools.dig?.durationMs, 20);
  assert.equal(result.activities[0]?.label, "#1 run_step");
  assert.equal(result.activities[0]?.startMs, 10);
  assert.equal(result.activities[2]?.status, "incomplete");
});

test("LLM attempts, token usage and post-response parsing errors are visible", () => {
  const metadata = { generationId: 1, phase: "coordinator", reflection: 1, round: 0, attempt: 0 };
  const result = summarizeTrace([
    event(100, "llm.request", metadata),
    event(200, "llm.raw_response", { ...metadata, raw: { usage: { prompt_tokens: 50, completion_tokens: 12 } } }),
    event(205, "llm.validation_error", { ...metadata, message: "invalid response" }),
  ]);
  assert.equal(result.llmCalls, 1);
  assert.equal(result.activities[0]?.status, "failed");
  assert.equal(result.promptTokens, 50);
  assert.equal(result.completionTokens, 12);
});

test("standalone report preserves untrusted text as JSON and its UI script compiles", () => {
  const payload = "</script><img src=x onerror=alert(1)>";
  const html = renderReport(payload, []);
  assert.equal(html.includes(payload), false);
  const data = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)![1]!;
  assert.equal(JSON.parse(data).campaignId, payload);
  const script = html.match(/<\/script><script>([\s\S]*?)<\/script>/)![1]!;
  assert.doesNotThrow(() => new vm.Script(script));
  assert.equal(html.includes("setInterval"), false);
});
