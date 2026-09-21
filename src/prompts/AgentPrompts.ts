import { join } from "node:path";
import { PromptTemplate } from "./PromptTemplate";

export interface AgentPrompts {
  readonly system: PromptTemplate;
  readonly intentClassifier: PromptTemplate;
  readonly resumeReview: PromptTemplate;
  readonly executionFinished: PromptTemplate;
  readonly executionIdle: PromptTemplate;
}

export async function loadAgentPrompts(
  rootPath: string,
): Promise<AgentPrompts> {
  console.info("Loading agent prompt templates.", { rootPath });
  const [
    system,
    intentClassifier,
    resumeReview,
    executionFinished,
    executionIdle,
  ] = await Promise.all([
    PromptTemplate.load(join(rootPath, "agent-system.md")),
    PromptTemplate.load(join(rootPath, "intent-classifier.md")),
    PromptTemplate.load(join(rootPath, "resume-review.md")),
    PromptTemplate.load(join(rootPath, "execution-finished.md")),
    PromptTemplate.load(join(rootPath, "execution-idle.md")),
  ]);

  const prompts = {
    system,
    intentClassifier,
    resumeReview,
    executionFinished,
    executionIdle,
  };
  console.info("Agent prompt templates loaded.", {
    files: Object.values(prompts).map((prompt) => prompt.sourcePath),
  });
  return prompts;
}
