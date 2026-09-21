import { loadAgentConfig } from "../src/agent/AgentConfig";
import type { LLMMessage } from "../src/llm/LLMClient";
import { OpenAICompatibleLLMClient } from "../src/llm/OpenAICompatibleLLMClient";

async function smoke(): Promise<void> {
  const config = loadAgentConfig();
  const client = new OpenAICompatibleLLMClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    requestTimeoutMs: config.llmRequestTimeoutMs,
  });

  const text = await client.complete({
    messages: [
      {
        role: "system",
        content: "Réponds directement, sans raisonnement ni explication.",
      },
      { role: "user", content: "Réponds uniquement par: ollama-ok" },
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
        content:
          'Appelle obligatoirement smoke_echo avec {"value":"tool-ok"}.',
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
      content: "Appelle smoke_echo puis confirme son résultat.",
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
        content: "Écris une très longue histoire sans t'arrêter.",
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
