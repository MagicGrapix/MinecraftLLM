import type { ActionDelegation, StepReportSummary } from "./ActionTypes";
import { formatPlanRecipes, type PlanRecipe } from "../recipes/PlanRecipes";

export function formatStepReports(reports: readonly StepReportSummary[]): string {
  return reports.length
    ? reports.map((report) => `- Step ${report.step} reported ${report.status}: ${line(report.message)}`).join("\n")
    : "No reports yet.";
}

/** Shared task view for coordinator and actioner, without duplicating physical tool results. */
export function formatTaskContext(input: {
  objective: string;
  checklist: string;
  currentStep?: ActionDelegation["step"];
  reports: readonly StepReportSummary[];
  recipes?: readonly PlanRecipe[];
}): string {
  if (!input.checklist) return "No plan yet.";
  return [
    `Objective: ${line(input.objective)}`,
    input.currentStep
      ? `Current step ${input.currentStep.step}: ${line(input.currentStep.title)}\nSuccess criterion: ${line(input.currentStep.successCriteria)}`
      : "Current step: none selected.",
    `Plan:\n${input.checklist}`,
    ...(input.recipes?.length ? [formatPlanRecipes(input.recipes)] : []),
    `Step reports (past claims; only [x] steps are coordinator-verified):\n${formatStepReports(input.reports)}`,
  ].join("\n\n");
}

function line(value: string): string { return value.replace(/\s+/g, " ").trim(); }
