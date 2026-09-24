import assert from "node:assert/strict";
import test from "node:test";
import { MemoryUpdater } from "../../../src/agent/MemoryUpdater";
import { WorkingMemory } from "../../../src/agent/WorkingMemory";
import { FakeLLMClient } from "../../../src/llm/FakeLLMClient";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";

test("memory updater replaces atomically and retries invalid JSON", async () => {
  const llm = new FakeLLMClient();
  const memory = new WorkingMemory(20);
  memory.replace("old fact");
  const retries: string[] = [];
  const updater = new MemoryUpdater({
    llm,
    prompt: PromptTemplate.fromString(
      "memory",
      "max={{max_chars}}\n{{memory_input}}",
    ),
    memory,
    maxRetries: 8,
    maxTokens: 200,
    notifyRetry: async (message) => {
      retries.push(message);
    },
  });

  llm.enqueue({
    message: { role: "assistant", content: "not-json" },
    finishReason: "stop",
  });
  llm.enqueue({
    message: {
      role: "assistant",
      content: JSON.stringify({ memory: "x".repeat(21) }),
    },
    finishReason: "stop",
  });
  llm.enqueue({
    message: {
      role: "assistant",
      content: JSON.stringify({ memory: "new fact" }),
    },
    finishReason: "stop",
  });

  const updated = await updater.update({
    runId: 1,
    reflection: 1,
    oldMemory: memory.read(),
    context: { phase: "review" },
    agentResponse: {
      message: { role: "assistant", content: "ok" },
      finishReason: "stop",
    },
    toolResults: [],
    signal: new AbortController().signal,
  });

  assert.equal(updated, "new fact");
  assert.equal(memory.read(), "new fact");
  assert.equal(retries.length, 2);
  assert.equal(
    llm.requests.every((request) => request.trace?.phase === "memory"),
    true,
  );
});
