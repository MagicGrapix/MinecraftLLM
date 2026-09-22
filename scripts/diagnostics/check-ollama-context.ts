import { loadAgentConfig } from "../../src/agent/AgentConfig";

interface RunningModel {
  readonly name?: string;
  readonly model?: string;
  readonly context_length?: number;
}

async function check(): Promise<void> {
  const config = loadAgentConfig();
  const expected = parseExpectedContext(
    process.env.OLLAMA_EXPECTED_CONTEXT_LENGTH,
  );
  const endpoint = ollamaProcessEndpoint(config.llmBaseUrl);
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(
      `Ollama returned HTTP ${response.status} from ${endpoint}.`,
    );
  }

  const payload = (await response.json()) as { models?: RunningModel[] };
  const models = Array.isArray(payload.models) ? payload.models : [];
  const active = models.find(
    (model) =>
      model.name === config.llmModel || model.model === config.llmModel,
  );
  if (!active) {
    const loaded = models
      .map((model) => model.name ?? model.model)
      .filter((name): name is string => Boolean(name));
    throw new Error(
      `Model "${config.llmModel}" is not currently loaded. Loaded models: ${loaded.join(", ") || "none"}. Run the bot or an Ollama request first, then retry.`,
    );
  }

  if (typeof active.context_length !== "number") {
    throw new Error(
      `Ollama did not report context_length for "${config.llmModel}".`,
    );
  }

  console.info("Ollama context check:", {
    model: config.llmModel,
    activeContextLength: active.context_length,
    requiredContextLength: expected,
    ok: active.context_length >= expected,
  });
  if (active.context_length < expected) {
    throw new Error(
      `Active context is ${active.context_length}; set Ollama Context length to at least ${expected}, reload the model, and retry.`,
    );
  }
}

function ollamaProcessEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/api/ps";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseExpectedContext(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 32_768;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "OLLAMA_EXPECTED_CONTEXT_LENGTH must be a positive integer.",
    );
  }
  return parsed;
}

void check().catch((error: unknown) => {
  console.error(
    "Ollama context check failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
