import { resolve } from "node:path";
import { loadAgentConfig } from "../src/agent/AgentConfig";
import { ChatIntentRouter } from "../src/chat/ChatIntentRouter";
import { OpenAICompatibleLLMClient } from "../src/llm/OpenAICompatibleLLMClient";
import { loadAgentPrompts } from "../src/prompts/AgentPrompts";

async function smokeIntent(): Promise<void> {
  const config = loadAgentConfig();
  const prompts = await loadAgentPrompts(
    resolve(process.cwd(), config.promptsDirectory),
  );
  const llm = new OpenAICompatibleLLMClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    requestTimeoutMs: config.llmRequestTimeoutMs,
  });
  const router = new ChatIntentRouter(llm, prompts.intentClassifier);
  const cases = [
    "salut, comment tu vas ?",
    "regarde ton inventaire et dis-moi ce que tu as",
    "construis une table de craft",
    "comment tu construirais une table de craft ?",
    "attends",
  ];

  for (const message of cases) {
    const intent = await router.route(message);
    console.info("Intent smoke result.", { message, ...intent });
  }
}

void smokeIntent().catch((error: unknown) => {
  console.error("Intent smoke test failed:", error);
  process.exitCode = 1;
});

