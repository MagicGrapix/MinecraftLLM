import { join, resolve } from "node:path";
import { loadAgentConfig } from "../../src/agent/AgentConfig";
import { ArchitectAgent } from "../../src/agent/ArchitectAgent";
import { ArchitectTools } from "../../src/agent/ArchitectTools";
import { BlueprintStore } from "../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../src/building/BlueprintValidator";
import { mcData } from "../../src/config";
import { AgentInspector } from "../../src/debug/AgentInspector";
import { getFullTraceFilePath, getLogFilePath } from "../../src/Logger";
import { OpenAICompatibleLLMClient } from "../../src/llm/OpenAICompatibleLLMClient";
import { PromptTemplate } from "../../src/prompts/PromptTemplate";
import { MaterialCatalog } from "../../src/world/MaterialCatalog";

/** Explicit opt-in: calls the configured LLM and writes a blueprint, never connects to Minecraft. */
async function main(): Promise<void> {
  const config = loadAgentConfig();
  const inspector = new AgentInspector();
  const catalog = new MaterialCatalog(mcData);
  const store = new BlueprintStore(new BlueprintValidator(catalog));
  const [prompt, contextSummaryPrompt, request] = await Promise.all([
    PromptTemplate.load(resolve(config.promptsDirectory, "architect.md")),
    PromptTemplate.load(resolve(config.promptsDirectory, "context-summary.md")),
    PromptTemplate.load(resolve(__dirname, "../../tests/fixtures/prompts/architect-request.md")),
  ]);
  const agent = new ArchitectAgent({
    llm: new OpenAICompatibleLLMClient({
      baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel,
      requestTimeoutMs: config.llmRequestTimeoutMs, maxRetries: 0, inspector,
    }),
    tools: new ArchitectTools(catalog, store), prompt, contextSummaryPrompt, inspector,
    temperature: config.llmTemperature, reasoningEffort: config.llmReasoningEffort, maxTokens: config.llmMaxTokens,
  });
  const stop = () => { void agent.requestStop(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.info("Architect-only smoke. No Minecraft connection.", {
    model: config.llmModel, log: getLogFilePath(), trace: getFullTraceFilePath(),
  });
  try {
    const userRequest = process.argv.slice(2).join(" ").trim() || request.render();
    const result = await agent.run({ userRequest, instruction: userRequest });
    console.info("Architect result:", result);
    if (!result.ok) { process.exitCode = 1; return; }
    const loaded = await store.load(result.value.blueprintId);
    if (!loaded.ok) throw new Error(`Saved blueprint could not be reloaded: ${loaded.error.message}`);
    console.info("Blueprint validated and reloaded:", join(store.directory, `${result.value.blueprintId}.json`));
    console.info("Only format/material validity was checked. No world access or construction was tested.");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await agent.requestStop();
  }
}

void main().catch((error: unknown) => { console.error("Architect smoke failed:", error); process.exitCode = 1; });
