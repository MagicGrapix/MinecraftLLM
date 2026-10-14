import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { summarizeBounded } from "../../../src/agent/BoundedSummary";
import { callStructuredRole } from "../../../src/agent/StructuredRoleCall";
import { estimateInputTokens } from "../../../src/llm/InputBudget";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { FakeLLMClient } from "../../support/FakeLLMClient";

test("large summaries fold all source fragments without exceeding 20k or losing their order", async () => {
  const source = { records: Array.from({ length: 150 }, (_, i) => ({ index: i, content: '"wood"\n'.repeat(350) })) };
  const llm = new FakeLLMClient();
  const pieces: string[] = [];
  for (let i = 0; i < 40; i++) llm.enqueue((request) => {
    assert.ok(estimateInputTokens(request.messages, request.tools) < 20_000);
    const data = JSON.parse(request.messages[0]!.content!);
    assert.equal(data.previousSummary, pieces.length ? "Summary " + pieces.length : "Initial fact");
    assert.equal(data.sourceFragment.offset, pieces.join("").length);
    pieces.push(data.sourceFragment.text);
    return { message: { role: "assistant", content: JSON.stringify({ summary: "Summary " + pieces.length }) }, finishReason: "stop" };
  });
  const result = await summarizeBounded({
    options: { llm, maxTokens: 4096, temperature: 0, maxRetries: 0 },
    prompt: PromptTemplate.fromString("summary", "{{summary_input}}"),
    source, previousSummary: "Initial fact", maxChars: 500, generationId: 1, reflection: 1,
    signal: new AbortController().signal, context: {}, phase: "context_summary",
  });
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(""), JSON.stringify(source));
  assert.equal(result, "Summary " + pieces.length);
});

test("every summary phase rejects oversized protected input before a model call", async () => {
  for (const phase of ["planner_context_summary", "summary", "context_summary", "actioner_context_summary", "architect_context_summary"] as const) {
    const llm = new FakeLLMClient();
    await assert.rejects(callStructuredRole({
      options: { llm, maxTokens: 4096, maxRetries: 8, temperature: 0 }, schema: z.object({}),
      phase, generationId: 1, reflection: 1,
      messages: [{ role: "system", content: "x".repeat(60_000) }], context: {}, signal: new AbortController().signal,
    }), /Request not sent/);
    assert.equal(llm.requests.length, 0);
  }
});
