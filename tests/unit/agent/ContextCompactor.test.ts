import assert from "node:assert/strict";
import test from "node:test";
import { ContextCompactor, estimateInputTokens } from "../../../src/agent/ContextCompactor";
import { MessageHistory } from "../../../src/agent/MessageHistory";
import { CONTEXT_BUDGET } from "../../../src/config";
import { FakeLLMClient } from "../../support/FakeLLMClient";
import type { LLMMessage } from "../../../src/llm/LLMClient";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";

const prompt = PromptTemplate.fromString("test", "Summarize under {{max_chars}} characters: {{summary_input}}");
const budget = { charsPerToken: 3, compactAtTokens: 2000, targetTokens: 1000, summaryMaxChars: 300 };
const render = (messages: readonly LLMMessage[], summary: string): LLMMessage[] => [
  { role: "system", content: "Current world." },
  { role: "assistant", content: "Previous conversation summary: " + (summary || "empty.") },
  ...messages,
];
function populated(mode: "native" | "compact" = "native") {
  const history = new MessageHistory(mode);
  history.append({ role: "user", content: "Earlier request" });
  history.append({ role: "assistant", content: "Earlier reply" });
  history.append({ role: "user", content: "Collect one NEW log, not the existing one." });
  for (let i = 0; i < 20; i++) history.appendExchange(
    { role: "assistant", content: "Observe", toolCalls: [{ id: String(i), name: "get_inventory", arguments: "{}" }] },
    [{ role: "tool", toolCallId: String(i), content: JSON.stringify({ index: i, note: "a".repeat(350) }) }],
  );
  return history;
}
function compactor(llm: FakeLLMClient) {
  return new ContextCompactor({ llm, temperature: 0, maxTokens: 4096, maxRetries: 0 }, prompt, budget);
}
function input(history: MessageHistory, signal = new AbortController().signal) {
  return { history, render, generationId: 1, reflection: 1, signal };
}
test("20k input estimate includes schemas, system, messages, and protocol overhead", () => {
  assert.equal(CONTEXT_BUDGET.compactAtTokens, 20000);
  assert.equal(CONTEXT_BUDGET.charsPerToken, 3);
  const messages = render([], "");
  const base = estimateInputTokens(messages);
  assert.ok(estimateInputTokens(messages, [{ name: "test", description: "x".repeat(6000), parameters: {} }]) > base + 2000);
});
test("compression replaces older groups but keeps active user in chronological place and latest exchange intact", async () => {
  for (const mode of ["native", "compact"] as const) {
    const history = populated(mode);
    const llm = new FakeLLMClient();
    llm.enqueue({ message: { role: "assistant", content: '{"summary":"Already held one log. Player wants one additional log. Pickup not yet verified."}' }, finishReason: "stop" });
    const messages = await compactor(llm).prepare(input(history));
    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0]!.trace?.phase, "context_summary");
    assert.match(llm.requests[0]!.messages[0]!.content!, /Earlier request/);
    assert.equal(messages[2]!.role, "user");
    assert.match(messages[2]!.content!, /NEW log/);
    assert.equal(messages.filter((m) => m.role === "user").length, 1);
    assert.equal(messages.at(-1)!.role, "tool");
    assert.ok(estimateInputTokens(messages) < budget.compactAtTokens);
    assert.match(messages[1]!.content!, /Pickup not yet verified/);
    let ids: string[] = [];
    for (const message of messages) {
      if (message.role === "tool") assert.equal(message.toolCallId, ids.shift());
      else { assert.equal(ids.length, 0); if (message.role === "assistant") ids = message.toolCalls?.map((c) => c.id) ?? []; }
    }
    assert.equal(ids.length, 0);
    await compactor(llm).prepare(input(history)); // Under threshold: no second call.
    assert.equal(llm.requests.length, 1);
  }
});
test("failed or aborted compression leaves summary and history untouched", async () => {
  for (const abort of [false, true]) {
    const history = populated();
    history.summary = "Older durable fact.";
    const before = history.snapshot();
    const llm = new FakeLLMClient();
    const controller = new AbortController();
    llm.enqueue(() => {
      if (abort) controller.abort();
      return { message: { role: "assistant", content: abort ? '{"summary":"valid"}' : '{"summary":""}' }, finishReason: "stop" };
    });
    await assert.rejects(compactor(llm).prepare(input(history, controller.signal)));
    assert.deepEqual(history.snapshot(), before);
    assert.equal(history.summary, "Older durable fact.");
  }
});
test("oversized protected inputs fail explicitly without discarding the active request", async () => {
  const history = new MessageHistory();
  history.append({ role: "user", content: "x".repeat(7000) });
  const before = history.snapshot();
  const llm = new FakeLLMClient();
  await assert.rejects(compactor(llm).prepare(input(history)), /protected input/);
  assert.deepEqual(history.snapshot(), before);
  assert.equal(llm.requests.length, 0);
});
test("compression cannot commit against a changed transcript", () => {
  const history = populated();
  const candidate = history.prepareCompaction(1000);
  history.append({ role: "user", content: "Different request" });
  assert.throws(() => candidate.commit("old summary"), /History changed/);
  assert.equal(history.snapshot().messages.at(-1)!.content, "Different request");
});
