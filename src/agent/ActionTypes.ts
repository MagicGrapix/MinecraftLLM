import type { Task } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";
import type { ConstructionContext } from "./ConstructionContext";
import type { PlanRecipe } from "../recipes/PlanRecipes";

export type ActionFinishStatus = "success" | "failure" | "needs_user";

export interface ActionTaskOutcome {
  readonly actionNumber?: number;
  readonly task: Task;
  readonly result: TaskResult;
}

/** A fresh, private conversation is created for each delegation. */
export interface ActionDelegation {
  readonly step: {
    readonly step: number;
    readonly title: string;
    readonly successCriteria: string;
    readonly checks?: string;
  };
  readonly planVersion: number;
  readonly recipes?: readonly PlanRecipe[];
  readonly userObjective: string;
  readonly checklist: string;
  readonly projectSummary: string;
  readonly reports: readonly StepReportSummary[];
  readonly construction?: ConstructionContext | null;
}

export interface DelegatedActionReport {
  readonly status: ActionFinishStatus | "interrupted";
  readonly message: string;
  readonly outcomes: readonly ActionTaskOutcome[];
}

/** Compact historical claims for prompts; actual TaskResults stay in the workflow. */
export interface StepReportSummary {
  readonly step: number;
  readonly status: DelegatedActionReport["status"];
  readonly message: string;
}

export interface DelegatedTraceContext {
  readonly generationId: number;
  readonly delegation: number;
}

/** Coordinator boundary: no dependency on actioner internals or prompt phases. */
export interface ActionRunner {
  runDelegatedStep(delegation: ActionDelegation, trace?: DelegatedTraceContext): Promise<DelegatedActionReport>;
  state(): { mode: string };
  requestStop(username?: string): Promise<void>;
  shutdown(): Promise<void>;
}
