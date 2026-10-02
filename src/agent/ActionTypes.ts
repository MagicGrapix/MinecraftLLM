import type { SequentialTaskOutcome } from "../execution/SequentialPlanRunner";
import type { AgentFinishStatus } from "./AgentDecision";

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
  readonly status: AgentFinishStatus | "interrupted";
  readonly message: string;
  readonly outcomes: readonly SequentialTaskOutcome[];
}

export interface DelegatedTraceContext {
  readonly generationId: number;
  readonly delegation: number;
}
