import { resolve } from "node:path";
import { loadAgentConfig } from "../../src/agent/AgentConfig";
import type { LLMMessage } from "../../src/llm/LLMClient";
import { OpenAICompatibleLLMClient } from "../../src/llm/OpenAICompatibleLLMClient";
import { PromptTemplate } from "../../src/prompts/PromptTemplate";

async function smoke(): Promise<void> {
  const config = loadAgentConfig();
  const client = new OpenAICompatibleLLMClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    requestTimeoutMs: config.llmRequestTimeoutMs,
  });
  const promptRoot = resolve(process.cwd(), config.promptsDirectory);
  const [systemPrompt, textPrompt, toolPrompt, replayPrompt, abortPrompt] =
    await Promise.all([
      PromptTemplate.load(resolve(promptRoot, "smoke-system.md")),
      PromptTemplate.load(resolve(promptRoot, "smoke-text-request.md")),
      PromptTemplate.load(resolve(promptRoot, "smoke-tool-request.md")),
      PromptTemplate.load(resolve(promptRoot, "smoke-tool-replay.md")),
      PromptTemplate.load(resolve(promptRoot, "smoke-abort-request.md")),
    ]);

  const text = await client.complete({
    messages: [
      {
        role: "system",
        content: systemPrompt.render(),
      },
      {
        role: "user",
        content: textPrompt.render({ expected_text: "ollama-ok" }),
      },
    ],
    temperature: 0,
    maxTokens: 256,
  });
  if (!text.message.content?.trim()) {
    throw new Error("Ollama returned an empty text response.");
  }
  console.info("text:", text.message.content);

  const tool = {
    name: "smoke_echo",
    description: "Return the supplied smoke value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  const first = await client.complete({
    messages: [
      {
        role: "user",
        content: toolPrompt.render({
          tool_name: "smoke_echo",
          arguments: '{"value":"tool-ok"}',
        }),
      },
    ],
    tools: [tool],
    temperature: 0,
    maxTokens: 128,
  });
  const call = first.message.toolCalls?.[0];
  if (!call) throw new Error("Ollama did not produce the expected tool call.");
  console.info("tool:", call);

  const replay: LLMMessage[] = [
    {
      role: "user",
      content: replayPrompt.render({ tool_name: "smoke_echo" }),
    },
    first.message,
    {
      role: "tool",
      toolCallId: call.id,
      content: JSON.stringify({ ok: true, value: "tool-ok" }),
    },
  ];
  const afterTool = await client.complete({
    messages: replay,
    tools: [tool],
    temperature: 0,
    maxTokens: 128,
  });
  console.info("replay:", afterTool.message.content);

  const abort = new AbortController();
  const pending = client.complete({
    messages: [
      {
        role: "user",
        content: abortPrompt.render(),
      },
    ],
    signal: abort.signal,
    maxTokens: 4_000,
  });
  setTimeout(() => abort.abort("smoke cancellation"), 10);
  try {
    await pending;
    throw new Error("Cancellation smoke request unexpectedly completed.");
  } catch (error: unknown) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ABORTED"
      )
    ) {
      throw error;
    }
    console.info("abort: ok");
  }
}

void smoke().catch((error: unknown) => {
  console.error("Ollama smoke test failed:", error);
  process.exitCode = 1;
});
