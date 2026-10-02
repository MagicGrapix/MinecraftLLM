import type { Task } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";

export type ActionFinishStatus = "success" | "failure" | "needs_user";

export interface ActionTaskOutcome {
  readonly task: Task;
  readonly result: TaskResult;
}

/** A fresh, private conversation is created for each delegation. */
export interface ActionDelegation {
  readonly step: {
    readonly step: number;
    readonly title: string;
    readonly successCriteria: string;
  };
  readonly instruction: string;
  readonly userObjective: string;
  readonly checklist: string;
  readonly projectSummary: string;
}

export interface DelegatedActionReport {
  readonly status: ActionFinishStatus | "interrupted";
  readonly message: string;
  readonly outcomes: readonly ActionTaskOutcome[];
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
