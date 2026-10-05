import { join } from "node:path";
import { PromptTemplate } from "./PromptTemplate";

export interface WorkflowPrompts {
  readonly coordinator: PromptTemplate;
  readonly planner: PromptTemplate;
  readonly actioner: PromptTemplate;
  readonly architect: PromptTemplate;
  readonly summary: PromptTemplate;
  readonly conversationSummary: PromptTemplate;
  readonly contextSummary: PromptTemplate;
}

export async function loadWorkflowPrompts(rootPath: string): Promise<WorkflowPrompts> {
  const [coordinator, planner, actioner, summary, conversationSummary, contextSummary, architect] = await Promise.all([
    PromptTemplate.load(join(rootPath, "coordinator.md")),
    PromptTemplate.load(join(rootPath, "planner.md")),
    PromptTemplate.load(join(rootPath, "actioner.md")),
    PromptTemplate.load(join(rootPath, "summary.md")),
    PromptTemplate.load(join(rootPath, "conversation-summary.md")),
    PromptTemplate.load(join(rootPath, "context-summary.md")),
    PromptTemplate.load(join(rootPath, "architect.md")),
  ]);
  console.info("Workflow prompts loaded.", { files: [coordinator.sourcePath, planner.sourcePath, actioner.sourcePath, summary.sourcePath, conversationSummary.sourcePath, contextSummary.sourcePath] });
  console.info("Architect prompt loaded.", { file: architect.sourcePath });
  return { coordinator, planner, actioner, summary, conversationSummary, contextSummary, architect };
}
