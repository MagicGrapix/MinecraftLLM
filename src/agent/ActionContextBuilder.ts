import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { Task, TaskSpec } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";
import type { LLMMessage } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { WorldQueries } from "../world/WorldQueries";
import type { ActionDelegation } from "./ActionTypes";
import { promptNumbers } from "./PromptNumberFormatter";
import { formatWorldContext } from "./WorldContextFormatter";

export interface ActionContextRequest {
  readonly delegation: ActionDelegation;
  readonly planDescription: string;
  readonly remainingPlan: readonly TaskSpec[];
  readonly lastTask: Task | null;
  readonly lastResult: TaskResult | null;
}

export class ActionContextBuilder {
  constructor(private readonly dependencies: {
    world: WorldQueries;
    landmarks: LandmarkMemory;
    capabilities: CapabilityRegistry;
    systemPrompt: PromptTemplate;
    conversationSummaryPrompt: PromptTemplate;
  }) {}

  build(request: ActionContextRequest) {
    const snapshot = {
      delegation: structuredClone(request.delegation),
      localPlan: { description: request.planDescription, remaining: structuredClone(request.remainingPlan) },
      self: this.dependencies.world.getSelf(),
      inventory: this.dependencies.world.getInventory(),
      pinnedLandmarks: this.dependencies.landmarks.pinned(),
      capabilities: this.dependencies.capabilities.list(),
      lastTask: request.lastTask ? structuredClone(request.lastTask) : null,
      lastResult: request.lastResult ? structuredClone(request.lastResult) : null,
    };
    const { step, userObjective, checklist, projectSummary, instruction } = snapshot.delegation;
    const taskContext = [
      `Delegated step ${step.step}: ${step.title}`,
      `Success criterion: ${step.successCriteria}`,
      `Overall player request: ${userObjective}`,
      `Global checklist (orientation only):\n${checklist || "No plan yet."}`,
      `Project summary: ${projectSummary || "No facts recorded yet."}`,
    ].join("\n");
    const localPlan = request.planDescription
      ? `${request.planDescription}\nPending actions: ${JSON.stringify(promptNumbers(request.remainingPlan))}`
      : "No local plan yet.";
    const lastAction = request.lastTask && request.lastResult
      ? JSON.stringify(promptNumbers({ capability: request.lastTask.capability, input: request.lastTask.input, result: request.lastResult }))
      : "No action attempted in this delegation yet.";
    const messages: LLMMessage[] = [
      { role: "system", content: this.dependencies.systemPrompt.render({
        task_context: taskContext,
        local_plan: localPlan,
        last_action: lastAction,
        capabilities: snapshot.capabilities.map(({ name, description }) => `${name}: ${description}`).join("\n"),
        world_context: formatWorldContext({ self: snapshot.self, inventory: snapshot.inventory, landmarks: snapshot.pinnedLandmarks }),
      }) },
      { role: "assistant", content: this.dependencies.conversationSummaryPrompt.render() },
      { role: "user", content: instruction },
    ];
    return { messages, snapshot };
  }
}
