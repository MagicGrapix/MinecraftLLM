import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleLLMClient } from "../../../src/llm/OpenAICompatibleLLMClient";

const options = {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "ollama",
  model: "qwen3.5:9b",
  requestTimeoutMs: 1_000,
};

test("OpenAI adapter maps text, usage, and all function calls", async () => {
  let sentBody: Record<string, unknown> | null = null;
  const client = new OpenAICompatibleLLMClient(options, {
    create: async (body) => {
      sentBody = body;
      return {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              reasoning: "I should inspect the world first.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_self",
                    arguments: "{}",
                  },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "get_inventory",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };
    },
  });

  const response = await client.complete({
    messages: [{ role: "user", content: "observe" }],
    responseFormat: "json_object",
    reasoningEffort: "none",
  });

  const actualBody = (sentBody ?? {}) as Record<string, unknown>;
  assert.equal(actualBody.model, options.model);
  assert.deepEqual(actualBody.response_format, { type: "json_object" });
  assert.equal(actualBody.reasoning_effort, "none");
  assert.deepEqual(response.message.toolCalls, [
    { id: "call_1", name: "get_self", arguments: "{}" },
    { id: "call_2", name: "get_inventory", arguments: "{}" },
  ]);
  assert.equal(response.reasoning, "I should inspect the world first.");
  assert.equal(response.usage?.totalTokens, 15);
});

test("OpenAI adapter preserves assistant tool calls before tool results", async () => {
  let sentMessages: unknown;
  const client = new OpenAICompatibleLLMClient(options, {
    create: async (body) => {
      sentMessages = body.messages;
      return {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "done" },
          },
        ],
      };
    },
  });

  await client.complete({
    messages: [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call_1", name: "get_self", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: '{"ok":true}' },
    ],
  });

  assert.deepEqual(sentMessages, [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_self", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: '{"ok":true}',
    },
  ]);
});

test("OpenAI adapter rejects missing choices as INVALID_RESPONSE", async () => {
  const client = new OpenAICompatibleLLMClient(options, {
    create: async () => ({ choices: [] }),
  });

  await assert.rejects(
    client.complete({ messages: [{ role: "user", content: "hello" }] }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_RESPONSE",
  );
});

test("OpenAI adapter maps AbortSignal cancellation", async () => {
  const controller = new AbortController();
  const client = new OpenAICompatibleLLMClient(options, {
    create: async (_body, request) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  const completion = client.complete({
    messages: [{ role: "user", content: "hello" }],
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    completion,
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ABORTED",
  );
});
