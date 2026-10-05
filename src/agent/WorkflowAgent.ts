import { writeTrace } from "../TraceLog";
import type { ToolCallJournal } from "../execution/ToolCallJournal";
import type { AgentInspector } from "../debug/AgentInspector";
import type { LLMClient, LLMMessage, LLMTool } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { WorkflowPrompts } from "../prompts/WorkflowPrompts";
import type { WorldQueries } from "../world/WorldQueries";
import type { ActionRunner } from "./ActionTypes";
import { actionReportForContext } from "./ActionReportFormatter";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import type { QueryError } from "../world/queries/QueryResult";
import { callCoordinator } from "./CoordinatorCall";
import { CoordinatorTools, type CoordinatorCall } from "./CoordinatorTools";
import { MessageHistory, type ToolReplayMode } from "./MessageHistory";
import { ContextCompactor, type ContextBudget } from "./ContextCompactor";
import { formatWorldContext, type WorldContextSnapshot } from "./WorldContextFormatter";
import { formatTaskContext } from "./TaskContextFormatter";
import { formatToolReference } from "./ToolCatalogBuilder";
import { callStructuredRole, type StructuredRoleOptions } from "./StructuredRoleCall";
import { summarizeBounded } from "./BoundedSummary";
import {
  PlannerResultSchema,
  WorkflowState,
  WorkflowSummaryFile,
} from "./WorkflowState";

export type WorkflowMode = "idle" | "thinking" | "planning" | "executing" | "stopped";

export interface WorkflowAgentOptions {
  readonly llm: LLMClient;
  readonly actionAgent: ActionRunner;
  readonly actionTools: readonly LLMTool[];
  readonly world: WorldQueries;
  readonly landmarks: LandmarkMemory;
  readonly queries: WorldQueryRegistry;
  readonly journal: ToolCallJournal;
  readonly prompts: WorkflowPrompts;
  readonly inspector?: AgentInspector;
  readonly temperature: number;
  readonly reasoningEffort?: StructuredRoleOptions["reasoningEffort"];
  readonly maxTokens: number;
  readonly maxRetries: number;
  readonly contextBudget?: ContextBudget;
  readonly toolReplayMode?: ToolReplayMode;
  readonly summaryMaxChars?: number;
  readonly summaryFile: WorkflowSummaryFile;
  readonly respond: (message: string, username?: string) => Promise<void>;
}

export class WorkflowAgent {
  readonly task = new WorkflowState();
  private readonly transcript: MessageHistory;
  private readonly tools: CoordinatorTools;
  private plansWithoutAction = 0;
  private mode: WorkflowMode = "idle";
  private activeUsername: string | null = null;
  private generationId = 0;
  private reflection = 0;
  private delegation = 0;
  private stopRequested = false;
  private shutdownRequested = false;
  private abort: AbortController | null = null;
  private processing: Promise<void> | null = null;

  constructor(private readonly options: WorkflowAgentOptions) {
    this.transcript = new MessageHistory(options.toolReplayMode);
    this.tools = new CoordinatorTools(options.queries);
  }

  state(): unknown {
    return {
      mode: this.mode,
      toolReplayMode: this.transcript.toolReplayMode,
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

  submitUserMessage(username: string, text: string): void {
    if (this.shutdownRequested || this.mode !== "idle" || !text.trim()) return;
    this.options.journal.startRequest();
    this.generationId += 1;
    this.reflection = 0;
    this.delegation = 0;
    this.plansWithoutAction = 0;
    this.activeUsername = username;
    this.task.start(text.trim());
    this.transcript.append({ role: "user", content: text.trim() });
    this.stopRequested = false;
    this.mode = "thinking";
    writeTrace("workflow.accepted", { generationId: this.generationId, username, text: text.trim() });
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
    try {
      await this.options.summaryFile.save(this.task);
      for (let turn = 0; turn < 64 && !this.stopRequested && !this.shutdownRequested; turn += 1) {
        this.mode = "thinking";
        const { call, parsed, message, trace } = await this.askCoordinator(signal);
        const actionNumber = this.options.journal.start(call.name, parsed.name === "run_step", {
          agent: "coordinator", generationId: this.generationId, toolCallId: call.id, arguments: call.arguments,
        });
        this.options.inspector?.recordToolStarted(trace, { actionNumber, toolCallId: call.id, name: call.name, arguments: call.arguments });
        let result: { ok: boolean; value?: unknown; error?: { message: string } };
        let terminal = false;
        try {
          signal.throwIfAborted();
          const executed = await this.executeTool(parsed, signal);
          result = { ok: true, value: executed.value };
          terminal = executed.terminal ?? false;
        } catch (error: unknown) {
          result = { ok: false, error: error instanceof QueryToolError ? error.details : { message: error instanceof Error ? error.message : String(error) } };
        }
        this.options.journal.complete(actionNumber, result.ok, JSON.stringify(result));
        const rawContent = JSON.stringify({ ...result, actionNumber });
        const content = rawContent;
        // Even aborted tools get a result: resume must never replay an orphan call.
        this.transcript.appendExchange(message, [{ role: "tool", toolCallId: call.id, content }]);
        this.options.inspector?.recordToolCompleted(trace, { actionNumber, toolCallId: call.id, name: call.name, arguments: call.arguments, result: rawContent, ok: result.ok });
        this.options.inspector?.finalizeRound(trace, signal.aborted ? "aborted" : "completed");
        await this.options.summaryFile.save(this.task);
        if (signal.aborted || this.stopRequested) { this.mode = "stopped"; return; }
        if (terminal) { this.finish(); return; }
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
      await this.options.summaryFile.save(this.task).catch((saveError: unknown) => {
        console.error("Could not save workflow issue to summary file:", saveError);
      });
      await this.reply(`[Bot] Workflow issue: ${issue}`);
      this.transcript.append({ role: "assistant", content: `[Bot] Workflow issue: ${issue}` });
      this.finish(issue);
    }
  }

  private async askCoordinator(signal: AbortSignal) {
    let context = this.commonContext();
    const reflection = ++this.reflection;
    const messages = await new ContextCompactor(this.roleOptions(), this.options.prompts.contextSummary, this.options.contextBudget).prepare({
      history: this.transcript,
      render: (messages, summary) => {
        context = this.commonContext();
        return this.roleInput(this.options.prompts.coordinator, context, { messages }, summary, formatTaskContext({
          objective: context.task.objective,
          checklist: context.task.checklist,
          currentStep: context.task.steps.find((step) => step.step === context.task.currentStep),
          reports: this.task.reportSummaries(),
        })).messages;
      },
      tools: this.tools.catalog(), generationId: this.generationId, reflection, signal, requestTitle: this.task.objective,
    });
    return callCoordinator({
      options: this.roleOptions(),
      tools: this.tools,
      generationId: this.generationId,
      reflection,
      messages,
      context,
      signal,
    });
  }

  private async askPlanner(instruction: string, signal: AbortSignal) {
    const history = new MessageHistory();
    history.summary = this.transcript.summary;
    for (const message of this.transcript.conversation().messages) history.append(message);
    const reflection = ++this.reflection;
    let context: Record<string, unknown> = {};
    const messages = await new ContextCompactor(this.roleOptions(), this.options.prompts.contextSummary, this.options.contextBudget).prepare({
      history, generationId: this.generationId, reflection, signal, requestTitle: this.task.objective,
      render: (recent, summary) => {
        const rendered = this.roleInput(this.options.prompts.planner,
          { ...this.commonContext(), instruction, actionTools: this.options.actionTools }, { messages: recent }, summary);
        context = rendered.context;
        return rendered.messages;
      },
    });
    const result = await callStructuredRole({
      options: this.roleOptions(),
      schema: PlannerResultSchema,
      phase: "planner",
      generationId: this.generationId,
      reflection,
      messages,
      context,
      signal,
    });
    return result;
  }

  private commonContext() {
    const task = this.task.snapshot();
    return {
      task,
      world: {
        self: this.options.world.getSelf(),
        inventory: this.options.world.getInventory(),
        landmarks: this.options.landmarks.pinned(),
      },
    };
  }

  private roleInput(prompt: PromptTemplate, currentContext: {
    task: ReturnType<WorkflowState["snapshot"]>;
    world: WorldContextSnapshot;
    instruction?: string;
    actionTools?: readonly LLMTool[];
  }, history: { messages: readonly LLMMessage[] }, summary = this.transcript.summary,
    taskContext = currentContext.task.checklist || "No plan yet."): {
    readonly context: Record<string, unknown>;
    readonly messages: readonly LLMMessage[];
  } {
    const context = {
      ...currentContext,
    };
    const { task, world, instruction } = currentContext;
    const messages: LLMMessage[] = [
      { role: "system", content: prompt.render({
        task_context: taskContext,
        task_summary_section: task.summary ? `## Task Summary\n\n${task.summary}` : "",
        instruction: instruction ?? "",
        world_context: formatWorldContext(world),
        action_tools: currentContext.actionTools ? formatToolReference(currentContext.actionTools) : "",
      }) },
      { role: "assistant", content: this.options.prompts.conversationSummary.render({ summary: summary || "empty. No earlier conversation has been compacted yet." }) },
      ...history.messages,
    ];
    return { context, messages };
  }

  private roleOptions(): StructuredRoleOptions {
    return {
      llm: this.options.llm,
      inspector: this.options.inspector,
      temperature: this.options.temperature,
      reasoningEffort: this.options.reasoningEffort,
      maxTokens: this.options.maxTokens,
      maxRetries: this.options.maxRetries,
      onRetry: async (phase, attempt) => {
        await this.options.respond(`[Bot] Invalid ${phase} response. Retrying (${attempt}/${this.options.maxRetries}).`, this.activeUsername ?? undefined);
      },
    };
  }

  private async executeTool(call: CoordinatorCall, signal: AbortSignal): Promise<{ value: unknown; terminal?: boolean }> {
    switch (call.name) {
      case "reply":
        if (call.input.outcome === "success" && (!this.task.steps.length || this.task.steps.some((step) => step.status !== "done"))) {
          throw new Error("Success requires a non-empty verified completed checklist. Use answer for a direct question.");
        }
        await this.reply(call.input.message);
        return { value: { sent: true, outcome: call.input.outcome }, terminal: true };
      case "query": {
        const result = await this.options.queries.execute(call.query, call.input, signal);
        signal.throwIfAborted();
        if (!result.ok) throw new QueryToolError(result.error);
        return { value: result.value };
      }
      case "ask_planner": {
        if (++this.plansWithoutAction > 4) throw new Error("Planning repeated without executing a step.");
        this.mode = "planning";
        const plan = await this.askPlanner(call.input.instruction, signal);
        signal.throwIfAborted();
        this.task.applyPlan(plan.steps);
        return { value: { planVersion: this.task.planVersion, steps: this.task.steps, replacesPreviousPlan: true } };
      }
      case "run_step": {
        const step = this.task.steps[call.input.step - 1];
        if (!step || step.status === "done") throw new Error("Select an unfinished step index from the CURRENT plan, or ask the planner first.");
        this.plansWithoutAction = 0;
        const planVersion = this.task.planVersion;
        const reports = this.task.reportSummaries();
        // Show the prior attempt to the actioner, but only this new attempt may authorize completion.
        delete this.task.reports[step.step];
        this.task.currentStep = step.step;
        step.status = "active";
        this.mode = "executing";
        const report = await this.options.actionAgent.runDelegatedStep({
          step: structuredClone(step), instruction: call.input.instruction, userObjective: this.task.objective,
          checklist: this.task.checklist(),
          projectSummary: this.task.summary,
          reports,
        }, { generationId: this.generationId, delegation: ++this.delegation }).catch((error: unknown) => {
          if (this.task.planVersion === planVersion) step.status = "blocked";
          throw error;
        });
        if (this.task.planVersion !== planVersion) throw new Error("Discarded a report for a replaced plan.");
        const recorded = { step: step.step, planVersion, report: structuredClone(report) };
        this.task.reports[step.step] = recorded;
        step.status = report.status === "success" ? "active" : "blocked";
        if (report.status === "interrupted") this.stopRequested = true;
        return { value: { ...recorded, report: actionReportForContext(report) } };
      }
      case "complete_step": {
        const step = this.task.steps[call.input.step - 1];
        const latest = this.task.reports[call.input.step];
        if (!step || !latest || latest.step !== step.step || latest.planVersion !== this.task.planVersion || latest.report.status !== "success") {
          throw new Error("Completion requires a matching successful report for this step in the current plan.");
        }
        step.status = "done";
        if (this.task.currentStep === step.step) this.task.currentStep = null;
        return { value: { step: step.step, status: step.status, planVersion: this.task.planVersion } };
      }
      case "refresh_summary": {
        const maxChars = this.options.summaryMaxChars ?? 500;
        const context = { ...this.commonContext(), maxChars, conversationSummary: this.transcript.summary, recentActivity: this.transcript.snapshot().messages };
        const summary = await summarizeBounded({
          options: this.roleOptions(), prompt: this.options.prompts.summary, source: context,
          previousSummary: this.task.summary, maxChars,
          allowEmpty: true,
          phase: "summary", generationId: this.generationId, reflection: ++this.reflection,
          context, signal,
        });
        signal.throwIfAborted();
        this.task.summary = summary;
        this.task.summaryVersion += 1;
        return { value: { updated: true, version: this.task.summaryVersion, characters: summary.length } };
      }
    }
  }

  private async reply(message: string): Promise<void> {
    await this.options.respond(message, this.activeUsername ?? undefined);
  }

  private finish(error?: string): void {
    this.mode = "idle";
    this.activeUsername = null;
    this.stopRequested = false;
    writeTrace("workflow.finished", { generationId: this.generationId, ...(error ? { error } : {}) });
  }
}

class QueryToolError extends Error {
  constructor(readonly details: QueryError) { super(details.message); }
}
