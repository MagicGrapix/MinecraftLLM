import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadAgentConfig } from "../../../src/agent/AgentConfig";
import { mcData } from "../../../src/config";
import { OpenAICompatibleLLMClient } from "../../../src/llm/OpenAICompatibleLLMClient";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { ArchitectWorkbench } from "./Workbench";
import { startWorkbenchServer } from "./Server";

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const workbench = new ArchitectWorkbench({
    directory: resolve("logs", "architect-workbench", `session_${Date.now()}_${randomUUID()}`),
    promptsDirectory: resolve(config.promptsDirectory), catalog: new MaterialCatalog(mcData),
    model: config.llmModel, temperature: config.llmTemperature,
    defaults: { maxTokens: config.llmMaxTokens, reasoningEffort: config.llmReasoningEffort },
    createClient: inspector => new OpenAICompatibleLLMClient({
      baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel,
      requestTimeoutMs: config.llmRequestTimeoutMs, maxRetries: 0, inspector,
    }),
  });
  const server = await startWorkbenchServer(workbench);
  console.info(`Architect workbench: ${server.url}\nModel: ${config.llmModel}\nTrials: ${workbench.state().directory}\nNo Minecraft connection. The LLM runs only when you launch a trial. Ctrl+C to stop.`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void server.close().catch(error => { console.error(error); process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
