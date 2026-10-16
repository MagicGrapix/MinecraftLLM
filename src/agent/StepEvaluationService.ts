import { z } from "zod";
import { evaluateStepChecks, type InventoryEvidenceReader } from "./StepCheckEvaluator";
import type { WorkflowState } from "./WorkflowState";

export const EvaluateStepSchema = z.object({ step: z.number().int().min(1).max(10) }).strict();
export const EVALUATE_STEP_DESCRIPTION = "Does: Check the current plan step's inventory requirements against a fresh server observation.\nReturns: Each comparison and true, false or unknown; false is not a tool error.\nLimits: Stock does not prove new collection or crafting; no checks means unknown. Does not mark completion.\nNotes: Action agent may evaluate only its delegated step. Review the natural success criterion too.";

/** Workflow-owned service shared by roles; deliberately not a world query or capability. */
export class StepEvaluationService {
  constructor(private readonly state: WorkflowState, private readonly read: InventoryEvidenceReader = async () => ({
    known: false, reason: "OBSERVATION_UNAVAILABLE", message: "No confirmed inventory reader configured.",
  })) {}

  async evaluate(step: number, signal: AbortSignal, scope?: { step: number; planVersion: number }) {
    signal.throwIfAborted();
    const version = this.state.planVersion;
    const selected = this.state.steps[step - 1];
    if (!Number.isInteger(step) || !selected) throw new Error("Select an existing step index from the CURRENT plan.");
    if (scope && (scope.step !== step || scope.planVersion !== version)) throw new Error("Evaluate only the delegated step of the current plan.");
    const checks = this.state.checksFor(step);
    const evidence = checks.length ? await this.read(signal) : { known: true as const, items: {} };
    signal.throwIfAborted();
    if (this.state.planVersion !== version || this.state.steps[step - 1] !== selected) throw new Error("Discarded evaluation for a replaced plan.");
    return evaluateStepChecks(step, checks, evidence);
  }
}
