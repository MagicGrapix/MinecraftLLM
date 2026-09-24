import { join } from "node:path";
import { PromptTemplate } from "./PromptTemplate";

export interface AgentPrompts {
  readonly system: PromptTemplate;
  readonly intentClassifier: PromptTemplate;
  readonly memoryUpdate: PromptTemplate;
}

export async function loadAgentPrompts(
  rootPath: string,
): Promise<AgentPrompts> {
  console.info("Loading agent prompt templates.", { rootPath });
  const [system, intentClassifier, memoryUpdate] = await Promise.all([
    PromptTemplate.load(join(rootPath, "agent-system.md")),
    PromptTemplate.load(join(rootPath, "intent-classifier.md")),
    PromptTemplate.load(join(rootPath, "memory-update.md")),
  ]);

  const prompts = {
    system,
    intentClassifier,
    memoryUpdate,
  };
  console.info("Agent prompt templates loaded.", {
    files: Object.values(prompts).map((prompt) => prompt.sourcePath),
  });
  return prompts;
}
