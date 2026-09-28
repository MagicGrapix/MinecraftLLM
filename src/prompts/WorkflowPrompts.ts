import { join } from "node:path";
import { PromptTemplate } from "./PromptTemplate";

export interface WorkflowPrompts {
  readonly coordinator: PromptTemplate;
  readonly planner: PromptTemplate;
  readonly actioner: PromptTemplate;
}

export async function loadWorkflowPrompts(rootPath: string): Promise<WorkflowPrompts> {
  const [coordinator, planner, actioner] = await Promise.all([
    PromptTemplate.load(join(rootPath, "coordinator.md")),
    PromptTemplate.load(join(rootPath, "planner.md")),
    PromptTemplate.load(join(rootPath, "actioner.md")),
  ]);
  console.info("Workflow prompts loaded.", { files: [coordinator.sourcePath, planner.sourcePath, actioner.sourcePath] });
  return { coordinator, planner, actioner };
}
