import { join } from "node:path";
import { PromptTemplate } from "./PromptTemplate";

export interface WorkflowPrompts {
  readonly coordinator: PromptTemplate;
  readonly planner: PromptTemplate;
  readonly actioner: PromptTemplate;
  readonly summary: PromptTemplate;
  readonly conversationSummary: PromptTemplate;
}

export async function loadWorkflowPrompts(rootPath: string): Promise<WorkflowPrompts> {
  const [coordinator, planner, actioner, summary, conversationSummary] = await Promise.all([
    PromptTemplate.load(join(rootPath, "coordinator.md")),
    PromptTemplate.load(join(rootPath, "planner.md")),
    PromptTemplate.load(join(rootPath, "actioner.md")),
    PromptTemplate.load(join(rootPath, "summary.md")),
    PromptTemplate.load(join(rootPath, "conversation-summary.md")),
  ]);
  console.info("Workflow prompts loaded.", { files: [coordinator.sourcePath, planner.sourcePath, actioner.sourcePath, summary.sourcePath, conversationSummary.sourcePath] });
  return { coordinator, planner, actioner, summary, conversationSummary };
}
