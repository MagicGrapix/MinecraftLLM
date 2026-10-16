import type { StepCheck } from "./StepChecks";

export type InventoryEvidence =
  | { readonly known: true; readonly items: Readonly<Record<string, number>> }
  | { readonly known: false; readonly reason: string; readonly message: string };
export type InventoryEvidenceReader = (signal: AbortSignal) => Promise<InventoryEvidence>;
export interface StepEvaluation {
  readonly step: number;
  readonly verdict: boolean | null;
  readonly reason?: string;
  readonly message?: string;
  readonly checks: readonly (StepCheck & { actual: number; passed: boolean })[];
}

/** Pure calculation on one coherent snapshot. Stock is not evidence of acquisition or crafting. */
export function evaluateStepChecks(step: number, checks: readonly StepCheck[], evidence: InventoryEvidence): StepEvaluation {
  if (!checks.length) return { step, verdict: null, reason: "NO_DETERMINISTIC_REQUIREMENTS", checks: [] };
  if (!evidence.known) return { step, verdict: null, reason: evidence.reason, message: evidence.message, checks: [] };
  const results = checks.map(check => {
    const actual = Object.hasOwn(evidence.items, check.item) ? evidence.items[check.item]! : 0;
    return { ...check, actual, passed: check.operator === ">=" ? actual >= check.expected
      : check.operator === "<=" ? actual <= check.expected : actual === check.expected };
  });
  if (results.some(r => !Number.isSafeInteger(r.actual) || r.actual < 0)) {
    return { step, verdict: null, reason: "INVALID_OBSERVATION", message: "Inventory counts are unknown.", checks: [] };
  }
  return { step, verdict: results.every(r => r.passed), checks: results };
}

export function formatStepEvaluation(result: StepEvaluation): string {
  return [
    `Step ${result.step} — ${result.verdict === true ? "satisfied" : result.verdict === false ? "not satisfied" : "unknown"}.`,
    ...(result.reason === "NO_DETERMINISTIC_REQUIREMENTS" ? ["No deterministic checks defined."]
      : result.reason ? [`${result.reason}: ${result.message ?? "Observation unavailable."}`] : []),
    ...result.checks.map(c => `${c.item}: ${c.actual} ${c.operator} ${c.expected} — ${c.passed}`),
    "Checks only; review the success criterion and action evidence before completing the step.",
  ].join("\n");
}
