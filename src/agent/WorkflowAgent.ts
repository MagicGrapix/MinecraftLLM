import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { AgentInspector } from "../debug/AgentInspector";
import type { LLMClient } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { WorkflowPrompts } from "../prompts/WorkflowPrompts";
import type { WorldQueries } from "../world/WorldQueries";
import type { DelegatedActionReport, SequentialAgent } from "./SequentialAgent";
import { callStructuredRole, type StructuredRoleOptions } from "./StructuredRoleCall";
import {
  ConversationHistory,
  CoordinatorDecisionSchema,
  PlannerResultSchema,
  WorkflowState,
  WorkflowSummaryFile,
  type CoordinatorDecision,
  type WorkflowStep,
} from "./WorkflowState";

export type WorkflowMode = "idle" | "thinking" | "planning" | "executing" | "stopped";

export interface WorkflowAgentOptions {
  readonly llm: LLMClient;
  readonly actionAgent: SequentialAgent;
  readonly world: WorldQueries;
  readonly capabilities: CapabilityRegistry;
  readonly landmarks: LandmarkMemory;
  readonly prompts: WorkflowPrompts;
  readonly inspector?: AgentInspector;
  readonly temperature: number;
  readonly reasoningEffort?: StructuredRoleOptions["reasoningEffort"];
  readonly maxTokens: number;
  readonly maxRetries: number;
  readonly historyMaxChars: number;
  readonly summaryFile: WorkflowSummaryFile;
  readonly respond: (message: string, username?: string) => Promise<void>;
}

export class WorkflowAgent {
  readonly history = new ConversationHistory();
  readonly task = new WorkflowState();
  private mode: WorkflowMode = "idle";
  private activeUsername: string | null = null;
  private readonlyOnly = false;
  private generationId = 0;
  private reflection = 0;
  private delegation = 0;
  private stopRequested = false;
  private shutdownRequested = false;
  private abort: AbortController | null = null;
  private processing: Promise<void> | null = null;

  constructor(private readonly options: WorkflowAgentOptions) {}

  state(): unknown {
    return {
      mode: this.mode,
      run: this.mode === "idle" ? null : {
        id: this.generationId,
        objective: this.task.objective,
        state: this.mode,
      },
      task: this.task.snapshot(),
      actionAgent: this.options.actionAgent.state(),
      summaryFile: this.options.summaryFile.path,
    };
  }

  submitUserMessage(username: string, text: string, readonlyOnly = false): void {
    if (this.shutdownRequested || this.mode !== "idle" || !text.trim()) return;
    this.generationId += 1;
    this.reflection = 0;
    this.delegation = 0;
    this.activeUsername = username;
    this.readonlyOnly = readonlyOnly;
    this.task.start(text.trim());
    this.history.append("user", text.trim());
    this.stopRequested = false;
    this.mode = "thinking";
    this.startProcessing();
  }

  async requestStop(username: string): Promise<void> {
    if (this.mode === "idle") {
      await this.options.respond("Bot already idle.", username);
      return;
    }
    if (this.mode === "stopped") {
      await this.options.respond("Bot already stopped.", username);
      return;
    }
    this.stopRequested = true;
    this.mode = "stopped";
    this.abort?.abort("Stopped by user.");
    if (this.options.actionAgent.state().mode !== "idle") {
      await this.options.actionAgent.requestStop(username);
    }
    await this.processing?.catch(() => undefined);
    await this.options.respond("Bot stopped. Use resume to continue.", username);
  }

  requestResume(username: string): void {
    if (this.shutdownRequested || this.mode !== "stopped" || this.activeUsername === null) return;
    void this.resumeAfterStop(username);
  }

  private async resumeAfterStop(username: string): Promise<void> {
    await this.processing?.catch(() => undefined);
    if (this.shutdownRequested || this.mode !== "stopped" || this.activeUsername === null) return;
    this.activeUsername = username;
    this.stopRequested = false;
    this.mode = "thinking";
    this.startProcessing();
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.stopRequested = true;
    this.abort?.abort("Workflow shutdown.");
    await this.options.actionAgent.shutdown();
    await this.processing?.catch(() => undefined);
  }

  private startProcessing(): void {
    const abort = new AbortController();
    this.abort = abort;
    const processing = this.process(abort.signal);
    const tracked = processing.finally(() => {
      if (this.abort === abort) this.abort = null;
      if (this.processing === tracked) this.processing = null;
    });
    this.processing = tracked;
  }

  private async process(signal: AbortSignal): Promise<void> {
    let handoffsWithoutAction = 0;
    try {
      await this.options.summaryFile.save(this.task);
      for (let turn = 0; turn < 24 && !this.stopRequested && !this.shutdownRequested; turn += 1) {
        this.mode = "thinking";
        const decision = await this.askCoordinator(signal);
        signal.throwIfAborted();
        this.applyCoordinatorState(decision);
        await this.options.summaryFile.save(this.task);

        if (decision.next === "reply") {
          if (decision.outcome === "success" && this.task.steps.some((step) => step.status !== "done")) {
            throw new Error("Coordinator declared success while checklist steps remain open.");
          }
          await this.reply(decision.message);
          this.finish();
          return;
        }
        if (this.readonlyOnly) {
          await this.reply("Only the configured owner may request Minecraft actions.");
          this.finish();
          return;
        }

        if (decision.next === "plan") {
          handoffsWithoutAction += 1;
          if (handoffsWithoutAction > 4) throw new Error("Planning repeated without executing a step.");
          this.mode = "planning";
          const plan = await this.askPlanner(decision.instruction, signal);
          signal.throwIfAborted();
          this.task.applyPlan(plan.steps);
          await this.options.summaryFile.save(this.task);
          continue;
        }

        const step = this.selectStep(decision);
        handoffsWithoutAction = 0;
        this.task.lastReport = null;
        step.status = "active";
        await this.options.summaryFile.save(this.task);
        this.mode = "executing";
        const instruction = JSON.stringify({
          step,
          instruction: decision.instruction,
          userObjective: this.task.objective,
          projectSummary: this.task.summary,
        });
        const report = await this.options.actionAgent.runDelegatedStep(instruction, {
          generationId: this.generationId,
          delegation: ++this.delegation,
        });
        this.task.lastReport = { stepId: step.id, report };
        step.status = report.status === "success" ? "active" : "blocked";
        await this.options.summaryFile.save(this.task);
        if (this.stopRequested || report.status === "interrupted") {
          this.mode = "stopped";
          return;
        }
      }
      if (!this.stopRequested && !this.shutdownRequested) {
        throw new Error("Workflow exceeded its handoff limit.");
      }
    } catch (error: unknown) {
      if (this.stopRequested || this.shutdownRequested || signal.aborted) {
        this.mode = "stopped";
        return;
      }
      console.error("Agent workflow failed:", error);
      const issue = error instanceof Error ? error.message : String(error);
      this.task.summary = `${this.task.summary}\nWorkflow issue: ${issue}`.trim().slice(-4_000);
      await this.options.summaryFile.save(this.task).catch((saveError: unknown) => {
        console.error("Could not save workflow issue to summary file:", saveError);
      });
      await this.reply(`[Bot] Workflow issue: ${issue}`);
      this.finish();
    }
  }

  private async askCoordinator(signal: AbortSignal): Promise<CoordinatorDecision> {
    const context = this.commonContext();
    const messages = [
      { role: "system" as const, content: this.options.prompts.coordinator.render() },
      { role: "user" as const, content: JSON.stringify({
        ...context,
        readonlyOnly: this.readonlyOnly,
        instruction: "Choose the next sequence and update the task summary/checklist verification.",
      }) },
    ];
    return callStructuredRole({
      options: this.roleOptions(),
      schema: CoordinatorDecisionSchema,
      phase: "coordinator",
      generationId: this.generationId,
      reflection: ++this.reflection,
      messages,
      context,
      signal,
    });
  }

  private async askPlanner(instruction: string, signal: AbortSignal): Promise<{ steps: readonly WorkflowStep[] }> {
    const context = { ...this.commonContext(), instruction };
    const result = await callStructuredRole({
      options: this.roleOptions(),
      schema: PlannerResultSchema,
      phase: "planner",
      generationId: this.generationId,
      reflection: ++this.reflection,
      messages: [
        { role: "system", content: this.options.prompts.planner.render() },
        { role: "user", content: JSON.stringify(context) },
      ],
      context,
      signal,
    });
    return { steps: result.steps.map((step) => ({ ...step, status: "pending" as const })) };
  }

  private commonContext() {
    return {
      task: this.task.snapshot(),
      conversation: this.history.forPrompt(this.options.historyMaxChars),
      world: {
        self: this.options.world.getSelf(),
        inventory: this.options.world.getInventory(),
        landmarks: this.options.landmarks.pinned(),
      },
      capabilities: this.options.capabilities.list(),
    };
  }

  private roleOptions(): StructuredRoleOptions {
    return {
      llm: this.options.llm,
      inspector: this.options.inspector,
      temperature: this.options.temperature,
      reasoningEffort: this.options.reasoningEffort,
      maxTokens: this.options.maxTokens,
      maxRetries: this.options.maxRetries,
    };
  }

  private applyCoordinatorState(decision: CoordinatorDecision): void {
    this.task.summary = decision.summary;
    const report = this.task.lastReport;
    for (const id of decision.completedStepIds) {
      if (!report || report.stepId !== id || report.report.status !== "success") {
        console.warn("Coordinator completion ignored without a matching successful report.", { id });
        continue;
      }
      const step = this.task.steps.find((candidate) => candidate.id === id);
      if (step) step.status = "done";
    }
    this.task.lastReport = null;
  }

  private selectStep(decision: Extract<CoordinatorDecision, { next: "act" }>): WorkflowStep {
    if (decision.newStep) {
      if (this.task.steps.length >= 10) throw new Error("The task checklist is full; replan before adding steps.");
      if (this.task.steps.some((step) => step.id === decision.newStep!.id)) {
        throw new Error(`Step id ${decision.newStep.id} already exists.`);
      }
      const step: WorkflowStep = { ...decision.newStep, status: "pending" };
      this.task.steps.push(step);
      return step;
    }
    const step = this.task.steps.find((candidate) => candidate.id === decision.stepId);
    if (!step || step.status === "done") throw new Error(`Invalid action step ${decision.stepId}.`);
    return step;
  }

  private async reply(message: string): Promise<void> {
    await this.options.respond(message, this.activeUsername ?? undefined);
    this.history.append("assistant", message);
  }

  private finish(): void {
    this.mode = "idle";
    this.activeUsername = null;
    this.readonlyOnly = false;
    this.stopRequested = false;
  }
}
