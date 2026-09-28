import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { DelegatedActionReport } from "./SequentialAgent";

export const PlanStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  title: z.string().trim().min(1).max(160),
  successCriteria: z.string().trim().min(1).max(400),
}).strict();

export const PlannerResultSchema = z.object({
  steps: z.array(PlanStepSchema).min(1).max(10),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.steps.forEach((step, index) => {
    if (ids.has(step.id)) {
      context.addIssue({ code: "custom", path: ["steps", index, "id"], message: "Duplicate step id." });
    }
    ids.add(step.id);
  });
});

const CoordinatorCommon = {
  summary: z.string().trim().max(4_000),
  completedStepIds: z.array(z.string()).max(10),
};

export const CoordinatorDecisionSchema = z.discriminatedUnion("next", [
  z.object({
    next: z.literal("reply"),
    ...CoordinatorCommon,
    outcome: z.enum(["answer", "success", "failure", "needs_user"]),
    message: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({
    next: z.literal("plan"),
    ...CoordinatorCommon,
    instruction: z.string().trim().min(1).max(1_000),
  }).strict(),
  z.object({
    next: z.literal("act"),
    ...CoordinatorCommon,
    instruction: z.string().trim().min(1).max(1_000),
    stepId: z.string().optional(),
    newStep: PlanStepSchema.optional(),
  }).strict(),
]).superRefine((value, context) => {
  if (value.next === "act" && Boolean(value.stepId) === Boolean(value.newStep)) {
    context.addIssue({ code: "custom", message: "Provide exactly one of stepId or newStep." });
  }
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type CoordinatorDecision = z.infer<typeof CoordinatorDecisionSchema>;

export interface WorkflowStep extends PlanStep {
  status: "pending" | "active" | "done" | "blocked";
}

export interface ConversationEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: number;
}

export class ConversationHistory {
  private readonly entries: ConversationEntry[] = [];

  append(role: ConversationEntry["role"], text: string): void {
    this.entries.push({ role, text, at: Date.now() });
  }

  all(): readonly ConversationEntry[] {
    return structuredClone(this.entries);
  }

  forPrompt(
    maxChars: number,
    maxEntries: number,
    excludeLatest: boolean,
  ): { entries: readonly ConversationEntry[]; omitted: number } {
    const selected: ConversationEntry[] = [];
    let length = 0;
    const available = this.entries.length - (excludeLatest ? 1 : 0);
    for (let index = available - 1; index >= 0 && selected.length < maxEntries; index -= 1) {
      const entry = this.entries[index]!;
      const size = JSON.stringify(entry).length;
      if (length + size > maxChars) break;
      selected.unshift(entry);
      length += size;
    }
    return { entries: structuredClone(selected), omitted: available - selected.length };
  }
}

export class WorkflowState {
  objective = "";
  summary = "";
  steps: WorkflowStep[] = [];
  lastReport: { stepId: string; report: DelegatedActionReport } | null = null;

  start(objective: string): void {
    this.objective = objective;
    this.steps = [];
    this.lastReport = null;
  }

  applyPlan(steps: readonly PlanStep[]): void {
    const done = this.steps.filter((step) => step.status === "done");
    const seen = new Set(done.map((step) => step.id));
    this.steps = [
      ...done,
      ...steps.filter((step) => !seen.has(step.id)).map((step) => ({ ...step, status: "pending" as const })),
    ];
    this.lastReport = null;
  }

  checklist(): string {
    return this.steps.map((step) =>
      `- [${step.status === "done" ? "x" : " "}] ${step.title} (${step.id}) — ${step.successCriteria}${step.status === "blocked" ? " [blocked]" : ""}`,
    ).join("\n");
  }

  snapshot() {
    return {
      objective: this.objective,
      summary: this.summary,
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
