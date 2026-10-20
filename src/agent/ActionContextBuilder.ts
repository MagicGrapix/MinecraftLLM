import type { Task } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";
import type { LLMMessage } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { WorldQueries } from "../world/WorldQueries";
import type { ActionDelegation } from "./ActionTypes";
import { formatWorldContext } from "./WorldContextFormatter";
import { formatTaskContext } from "./TaskContextFormatter";
import { formatConstructionContext } from "./ConstructionContext";

export interface ActionContextRequest {
  readonly delegation: ActionDelegation;
  readonly lastTask: Task | null;
  readonly lastResult: TaskResult | null;
  readonly conversationSummary?: string;
}

export class ActionContextBuilder {
  constructor(private readonly dependencies: {
    world: WorldQueries;
    landmarks: LandmarkMemory;
    systemPrompt: PromptTemplate;
    conversationSummaryPrompt: PromptTemplate;
  }) {}

  build(request: ActionContextRequest) {
    const snapshot = {
      delegation: structuredClone(request.delegation),
      self: this.dependencies.world.getSelf(),
      inventory: this.dependencies.world.getInventory(),
      pinnedLandmarks: this.dependencies.landmarks.pinned(),
      lastTask: request.lastTask ? structuredClone(request.lastTask) : null,
      lastResult: request.lastResult ? structuredClone(request.lastResult) : null,
    };
    const { step, userObjective, checklist, projectSummary, reports, recipes } = snapshot.delegation;
    const taskContext = formatTaskContext({ objective: userObjective, checklist, currentStep: step, reports, recipes });
    const messages: LLMMessage[] = [
      { role: "system", content: this.dependencies.systemPrompt.render({
        task_context: taskContext,
        construction_context: formatConstructionContext(snapshot.delegation.construction),
        task_summary_section: projectSummary ? `## Task Summary\n\n${projectSummary}` : "",
        world_context: formatWorldContext({ self: snapshot.self, inventory: snapshot.inventory, landmarks: snapshot.pinnedLandmarks }),
      }) },
      { role: "assistant", content: this.dependencies.conversationSummaryPrompt.render({ summary: request.conversationSummary || "empty. No earlier conversation has been compacted yet." }) },
      { role: "user", content: `Execute step ${step.step} of the current plan.` },
    ];
    return { messages, snapshot };
  }
}
