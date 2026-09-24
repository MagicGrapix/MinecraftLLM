import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { Task, TaskSpec } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";
import type { LLMMessage } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { WorldQueries } from "../world/WorldQueries";
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
  readonly self: unknown;
  readonly inventory: unknown;
  readonly pinnedLandmarks: unknown;
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
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: this.dependencies.systemPrompt.render({
          current_context: JSON.stringify(snapshot),
        }),
      },
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
