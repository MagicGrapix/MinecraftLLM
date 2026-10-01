import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { Task, TaskSpec } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";
import type { LLMMessage } from "../llm/LLMClient";
import type { Landmark, LandmarkMemory } from "../memory/LandmarkMemory";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { WorldQueries } from "../world/WorldQueries";
import type { InventoryState, SelfState } from "../world/types";
import { formatWorldContext } from "./WorldContextFormatter";
import { promptNumbers } from "./PromptNumberFormatter";
import type { AgentPermissionMode } from "./AgentToolBridge";

export type AgentReflectionPhase = "question" | "planning" | "review";

export interface AgentContextRequest {
  readonly runId: number;
  readonly phase: AgentReflectionPhase;
  readonly permission: AgentPermissionMode;
  readonly objective: string;
  readonly workingMemory: string;
  readonly currentTask: Task | null;
  readonly lastTask: Task | null;
  readonly lastResult: TaskResult | null;
  readonly remainingPlan: readonly TaskSpec[];
  readonly currentMessage?: string;
  readonly instruction: string;
}

export interface AgentContextSnapshot {
  readonly runId: number;
  readonly phase: AgentReflectionPhase;
  readonly permission: AgentPermissionMode;
  readonly objective: string;
  readonly workingMemory: string;
  readonly self: SelfState;
  readonly inventory: InventoryState;
  readonly pinnedLandmarks: readonly Landmark[];
  readonly currentTask: Task | null;
  readonly lastTask: Task | null;
  readonly lastResult: TaskResult | null;
  readonly remainingPlan: readonly TaskSpec[];
  readonly capabilities: readonly { name: string; description: string }[];
  readonly currentMessage?: string;
}

export interface BuiltAgentContext {
  readonly messages: readonly LLMMessage[];
  readonly snapshot: AgentContextSnapshot;
}

export class AgentContextBuilder {
  constructor(
    private readonly dependencies: {
      world: WorldQueries;
      landmarks: LandmarkMemory;
      capabilities: CapabilityRegistry;
      systemPrompt: PromptTemplate;
      conversationSummaryPrompt: PromptTemplate;
    },
  ) {}

  build(request: AgentContextRequest): BuiltAgentContext {
    const snapshot: AgentContextSnapshot = {
      runId: request.runId,
      phase: request.phase,
      permission: request.permission,
      objective: request.objective,
      workingMemory: request.workingMemory,
      self: this.dependencies.world.getSelf(),
      inventory: this.dependencies.world.getInventory(),
      pinnedLandmarks: this.dependencies.landmarks.pinned(),
      currentTask: request.currentTask
        ? structuredClone(request.currentTask)
        : null,
      lastTask: request.lastTask
        ? structuredClone(request.lastTask)
        : null,
      lastResult: request.lastResult
        ? structuredClone(request.lastResult)
        : null,
      remainingPlan: structuredClone(request.remainingPlan),
      capabilities: this.dependencies.capabilities.list(),
      ...(request.currentMessage === undefined
        ? {}
        : { currentMessage: request.currentMessage }),
    };
    const { self, inventory, pinnedLandmarks, ...actionContext } = snapshot;
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: this.dependencies.systemPrompt.render({
          current_context: JSON.stringify(promptNumbers(actionContext), null, 2),
          world_context: formatWorldContext({ self, inventory, landmarks: pinnedLandmarks }),
        }),
      },
      { role: "assistant", content: this.dependencies.conversationSummaryPrompt.render() },
      { role: "user", content: request.instruction },
    ];
    console.debug("Sequential agent context assembled.", {
      runId: request.runId,
      phase: request.phase,
      permission: request.permission,
      remainingTasks: request.remainingPlan.length,
      hasCurrentTask: request.currentTask !== null,
      hasLastResult: request.lastResult !== null,
      messageCount: messages.length,
      contextChars: JSON.stringify(messages).length,
    });
    return { messages, snapshot };
  }
}
