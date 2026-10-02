import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { DelegatedActionReport } from "./ActionTypes";

export const PlanStepSchema = z.object({
  title: z.string().trim().min(1).max(160),
  successCriteria: z.string().trim().min(1).max(400),
}).strict();

export const PlannerResultSchema = z.object({
  steps: z.array(PlanStepSchema).min(1).max(10),
}).strict();

export type PlanStep = z.infer<typeof PlanStepSchema>;

export interface WorkflowStep extends PlanStep {
  readonly step: number;
  status: "pending" | "active" | "done" | "blocked";
}

export class WorkflowState {
  objective = "";
  summary = "";
  summaryVersion = 0;
  planVersion = 0;
  steps: WorkflowStep[] = [];
  lastReport: { step: number; planVersion: number; report: DelegatedActionReport } | null = null;

  start(objective: string): void {
    this.objective = objective;
    this.steps = [];
    this.lastReport = null;
    this.planVersion += 1;
  }

  applyPlan(steps: readonly PlanStep[]): void {
    this.planVersion += 1;
    this.steps = steps.map((step, index) => ({ ...step, step: index + 1, status: "pending" }));
    this.lastReport = null;
  }

  checklist(): string {
    return this.steps.map((step) =>
      `- [${step.status === "done" ? "x" : " "}] ${step.step}. ${step.title} — ${step.successCriteria}${step.status === "blocked" ? " [blocked]" : ""}`,
    ).join("\n");
  }

  snapshot() {
    return {
      objective: this.objective,
      summary: this.summary,
      summaryVersion: this.summaryVersion,
      planVersion: this.planVersion,
      steps: structuredClone(this.steps),
      checklist: this.checklist(),
      lastReport: this.lastReport ? structuredClone(this.lastReport) : null,
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
