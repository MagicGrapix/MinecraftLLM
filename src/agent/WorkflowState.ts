import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { PLAN_LIMITS, RECIPE_LIMITS } from "../config";
import { ItemNameSchema } from "../recipes/RecipeSchema";
import { formatPlanRecipes, recipeKey, type PlanRecipe } from "../recipes/PlanRecipes";
import { parseStepChecks, type StepCheck } from "./StepChecks";
import type { DelegatedActionReport, StepReportSummary } from "./ActionTypes";
import { formatStepReports } from "./TaskContextFormatter";
import { formatConstructionContext, type ConstructionContext } from "./ConstructionContext";

export const PlanStepSchema = z.object({
  title: z.string().trim().min(1).max(160),
  successCriteria: z.string().trim().min(1).max(400),
  recipes: z.array(z.object({ item: ItemNameSchema, variant: z.number().int().min(1).max(RECIPE_LIMITS.maxVariants) }).strict())
    .max(PLAN_LIMITS.recipesPerStep).optional().describe("Selected documented variants already read successfully; omit if no documented recipe is used."),
  checks: z.string().max(PLAN_LIMITS.checkChars).optional().describe("Optional inventory checks, one per line, all required. Example: inventory_count(stick) >= 4. Only >=, ==, <= and exact registered item names. Max 8 lines. Empty means no deterministic checks, not success. Stock is not proof of crafting or new collection."),
}).strict();

export const PlannerResultSchema = z.object({
  steps: z.array(PlanStepSchema).min(1).max(10),
}).strict();

export type PlanStep = z.infer<typeof PlanStepSchema>;

export interface WorkflowStep extends PlanStep {
  readonly step: number;
  status: "pending" | "active" | "done" | "blocked";
}

export interface WorkflowStepReport {
  readonly step: number;
  readonly planVersion: number;
  readonly report: DelegatedActionReport;
}

export class WorkflowState {
  objective = "";
  summary = "";
  summaryVersion = 0;
  planVersion = 0;
  steps: WorkflowStep[] = [];
  currentStep: number | null = null;
  reports: Record<number, WorkflowStepReport> = {};
  construction: ConstructionContext | null = null;
  recipes: PlanRecipe[] = [];
  private compiledChecks: StepCheck[][] = [];

  start(objective: string): void {
    this.objective = objective;
    this.construction = null;
    this.steps = [];
    this.recipes = [];
    this.compiledChecks = [];
    this.currentStep = null;
    this.reports = {};
    this.planVersion += 1;
  }

  applyPlan(steps: readonly PlanStep[], recipes: readonly PlanRecipe[] = [], isKnownItem: (item: string) => boolean = () => false): void {
    // Prepare everything before mutation; invalid replans cannot destroy an accepted plan or its reports.
    const compiled = steps.map((step, i) => parseStepChecks(step.checks ?? "", isKnownItem, i + 1));
    const selected = new Map(recipes.map(recipe => [recipeKey(recipe), structuredClone(recipe)]));
    const needed = new Set(steps.flatMap(step => (step.recipes ?? []).map(recipeKey)));
    if (needed.size > PLAN_LIMITS.uniqueRecipes || [...needed].some(key => !selected.has(key))) throw new Error("Invalid plan recipe snapshots; previous plan unchanged.");
    const nextSteps: WorkflowStep[] = steps.map((step, index) => ({ ...structuredClone(step), step: index + 1, status: "pending" }));
    this.planVersion += 1;
    this.steps = nextSteps;
    this.recipes = [...needed].map(key => selected.get(key)!);
    this.compiledChecks = compiled;
    this.currentStep = null;
    this.reports = {};
  }

  checksFor(step: number): readonly StepCheck[] { return structuredClone(this.compiledChecks[step - 1] ?? []); }

  recipesFor(step: number): PlanRecipe[] {
    const keys = new Set((this.steps[step - 1]?.recipes ?? []).map(recipeKey));
    return structuredClone(this.recipes.filter(recipe => keys.has(recipeKey(recipe))));
  }

  selectBlueprint(construction: ConstructionContext): void {
    this.construction = structuredClone(construction);
    // Reports/checkmarks refer to the old design. Existing world blocks are untouched.
    this.applyPlan([]);
  }

  reportSummaries(): StepReportSummary[] {
    return Object.values(this.reports)
      .filter((entry) => entry.planVersion === this.planVersion)
      .sort((a, b) => a.step - b.step)
      .map(({ step, report }) => ({ step, status: report.status, message: report.message }));
  }

  checklist(): string {
    return this.steps.map((step) =>
      `- [${step.status === "done" ? "x" : " "}] ${step.step}. ${step.title} — ${step.successCriteria}${step.status === "blocked" ? " [blocked]" : ""}` +
      (step.checks?.trim() ? `\n  Checks:\n${step.checks.trim().split(/\r?\n/).map(line => `    ${line}`).join("\n")}` : "") +
      (step.recipes?.length ? `\n  Recipes: ${step.recipes.map(ref => `${ref.item} (variant ${ref.variant})`).join(", ")}` : ""),
    ).join("\n");
  }

  snapshot() {
    return {
      objective: this.objective,
      summary: this.summary,
      summaryVersion: this.summaryVersion,
      planVersion: this.planVersion,
      steps: structuredClone(this.steps),
      recipes: structuredClone(this.recipes),
      checklist: this.checklist(),
      currentStep: this.currentStep,
      reports: structuredClone(this.reports),
      construction: structuredClone(this.construction),
    };
  }
}

export class WorkflowSummaryFile {
  readonly path: string;

  constructor(sessionId: string, root = resolve(process.cwd(), "logs")) {
    this.path = join(root, `agent_summary_${sessionId}.md`);
  }

  async save(state: WorkflowState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const content = [
      "# Agent task summary",
      "",
      `Objective: ${state.objective || "(none)"}`,
      "",
      "## Steps",
      "",
      state.checklist() || "No steps yet.",
      formatPlanRecipes(state.recipes),
      "",
      `Current step: ${state.currentStep ?? "none selected"}`,
      "",
      "## Construction",
      "",
      formatConstructionContext(state.construction),
      "",
      "## Step reports (claims, not checklist verification)",
      "",
      formatStepReports(state.reportSummaries()),
      "",
      "## What happened",
      "",
      state.summary || "No facts recorded yet.",
      "",
    ].join("\n");
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, this.path);
  }
}
