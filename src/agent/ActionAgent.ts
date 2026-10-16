import { ACTION_MAX_TOOL_CALLS } from "../config";
import { writeTrace } from "../TraceLog";
import { completeWithinBudget } from "../llm/InputBudget";
import type { AgentInspector } from "../debug/AgentInspector";
import type { Executor } from "../execution/Executor";
import type { Task } from "../execution/Task";
import { TaskFactory } from "../execution/TaskFactory";
import { numberedToolResult, type ToolCallJournal } from "../execution/ToolCallJournal";
import type { TaskResult } from "../execution/TaskResult";
import type { LLMClient, LLMRequestTrace, LLMResponse, LLMToolCall } from "../llm/LLMClient";
import type { ActionContextBuilder } from "./ActionContextBuilder";
import type { ActionDelegation, ActionTaskOutcome, DelegatedActionReport, DelegatedTraceContext, ActionRunner } from "./ActionTypes";
import type { AgentToolBridge, ValidatedActionCall } from "./AgentToolBridge";
import { MessageHistory, withValidationFeedback, type ToolReplayMode } from "./MessageHistory";
import { ModelResponseError, isModelResponseError } from "./ModelResponseError";
import { ContextCompactor, type ContextBudget } from "./ContextCompactor";
import type { PromptTemplate } from "../prompts/PromptTemplate";

type ActionMode = "idle" | "thinking" | "executing" | "stopped";

interface ActionAgentOptions {
  readonly llm: LLMClient;
  readonly contextBuilder: ActionContextBuilder;
  readonly toolBridge: AgentToolBridge;
  readonly executor: Executor;
  readonly journal: ToolCallJournal;
  readonly maxToolCalls?: number;
  readonly maxResponseRetries: number;
  readonly temperature: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
  readonly maxTokens: number;
  readonly contextSummaryPrompt: PromptTemplate;
  readonly contextBudget?: ContextBudget;
  readonly toolReplayMode?: ToolReplayMode;
  readonly inspector?: AgentInspector;
  readonly onRetry?: (message: string) => Promise<void>;
  readonly onTaskFinished?: (outcome: ActionTaskOutcome) => Promise<void>;
}

interface ActionSession {
  readonly id: number;
  readonly delegation: ActionDelegation;
  readonly trace?: DelegatedTraceContext;
  readonly abort: AbortController;
  readonly history: MessageHistory;
  readonly outcomes: ActionTaskOutcome[];
  lastTask: Task | null;
  lastResult: TaskResult | null;
  round: number;
}

/** One prompt, one private conversation, one direct awaited tool at a time. */
export class ActionAgent implements ActionRunner {
  private mode: ActionMode = "idle";
  private session: ActionSession | null = null;
  private processing: Promise<DelegatedActionReport> | null = null;
  private shutdownRequested = false;
  private nextId = 0;
  private readonly taskFactory = new TaskFactory();
  private readonly maxToolCalls: number;

  constructor(private readonly options: ActionAgentOptions) {
    this.maxToolCalls = options.maxToolCalls ?? ACTION_MAX_TOOL_CALLS;
    if (!Number.isSafeInteger(this.maxToolCalls) || this.maxToolCalls < 1) {
      throw new Error("Action tool call limit must be a positive integer.");
    }
  }

  runDelegatedStep(delegation: ActionDelegation, trace?: DelegatedTraceContext): Promise<DelegatedActionReport> {
    if (this.shutdownRequested || this.session || this.options.executor.currentTask) {
      return Promise.reject(new Error("Action agent is unavailable."));
    }
    if (!Number.isSafeInteger(delegation.planVersion) || delegation.planVersion < 1 || !delegation.step.title.trim() || !delegation.step.successCriteria.trim() ||
      !Number.isInteger(delegation.step.step) || delegation.step.step < 1) {
      return Promise.reject(new Error("A numbered step, success criterion and plan version are required."));
    }
    const session: ActionSession = {
      id: ++this.nextId, delegation: structuredClone(delegation), trace,
      abort: new AbortController(),
      history: new MessageHistory(this.options.toolReplayMode),
      outcomes: [], lastTask: null, lastResult: null, round: 0,
    };
    this.session = session;
    this.mode = "thinking";
    console.info("Action delegation started.", { request: trace?.generationId ?? session.id, step: delegation.step.step, planVersion: delegation.planVersion });
    const tracked = this.process(session).finally(() => {
      session.history.clear();
      if (this.session === session) { this.session = null; this.mode = "idle"; }
      if (this.processing === tracked) this.processing = null;
    });
    this.processing = tracked;
    return tracked;
  }

  state() {
    const session = this.session;
    return {
      mode: this.mode,
      run: session ? {
        id: session.id, objective: session.delegation.userObjective, state: this.mode,
        step: structuredClone(session.delegation.step), toolCalls: session.round,
        currentTask: structuredClone(this.options.executor.currentTask),
        lastTask: structuredClone(session.lastTask), lastResult: structuredClone(session.lastResult),
      } : null,
    };
  }

  async requestStop(_username?: string): Promise<void> {
    if (!this.session) return;
    this.mode = "stopped";
    this.session.abort.abort("Stopped by user.");
    this.options.executor.abortCurrent("Stopped by user.");
    // Preserve the settled TaskResult before handing control back to the coordinator.
    await this.processing;
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    await this.requestStop();
  }

  private async process(session: ActionSession): Promise<DelegatedActionReport> {
    const signal = session.abort.signal;
    try {
      while (true) {
        signal.throwIfAborted();
        this.mode = "thinking";
        const { response, validated, trace } = await this.completeValidatedCall(session);
        const call = response.message.toolCalls![0]!;
        const actionNumber = this.options.journal.start(call.name, validated.kind === "action", {
          agent: "actioner", generationId: trace.generationId, toolCallId: call.id, arguments: call.arguments,
        });
        this.options.inspector?.recordToolStarted(trace, { actionNumber, toolCallId: call.id, name: call.name, arguments: call.arguments });
        let report: DelegatedActionReport | undefined;
        try {
          let content: string;
          let feedback: string | undefined;
          let ok: boolean;
          if (signal.aborted) {
            content = JSON.stringify({ ok: false, error: { code: "INTERRUPTED", message: "Delegation stopped; tool was not executed." } });
            ok = false;
          } else if (validated.kind === "read") {
            const read = await this.options.toolBridge.executeRead(call, signal, { step: session.delegation.step.step, planVersion: session.delegation.planVersion });
            content = read.content;
            feedback = read.feedback;
            ok = read.ok;
          } else if (validated.kind === "action") {
            signal.throwIfAborted();
            const task = this.taskFactory.create(validated.task);
            this.mode = "executing";
            const startedAt = Date.now();
            writeTrace("action.task_started", { actionNumber, toolCallId: call.id, taskId: task.id, capability: task.capability });
            console.info("Action capability started.", { step: session.delegation.step.step, capability: task.capability, input: task.input });
            const result = await this.options.executor.execute(task);
            // Capture before observers or another call can change the inventory.
            this.options.journal.complete(actionNumber, result.ok, JSON.stringify(result));
            const outcome = { actionNumber, task: structuredClone(task), result: structuredClone(result) };
            session.outcomes.push(outcome);
            session.lastTask = outcome.task;
            session.lastResult = outcome.result;
            console.info("Action capability completed.", { capability: task.capability, ok: result.ok, durationMs: Date.now() - startedAt });
            try { await this.options.onTaskFinished?.(structuredClone(outcome)); }
            catch (error: unknown) { console.error("Action outcome observer failed:", error); }
            // The native tool gets its TaskResult, not a queue/task metadata wrapper.
            content = JSON.stringify(result);
            ok = result.ok;
          } else {
            report = this.report(session, validated.status, validated.message);
            content = JSON.stringify({ ok: true, value: { status: validated.status, message: validated.message } });
            ok = true;
          }
          this.options.journal.complete(actionNumber, ok, content);
          content = numberedToolResult(actionNumber, content);
          this.options.inspector?.recordToolCompleted(trace, { actionNumber, toolCallId: call.id, name: call.name, arguments: call.arguments, result: content, ok });
          session.history.appendExchange(response.message, [{ role: "tool", toolCallId: call.id,
            content: feedback === undefined ? content : `Action #${actionNumber}\n${feedback}` }]);
          this.options.inspector?.finalizeRound(trace, signal.aborted ? "aborted" : "completed");
        } catch (error: unknown) {
          this.options.journal.complete(actionNumber, false, JSON.stringify({ ok: false, error: { message: errorMessage(error) } }));
          this.options.inspector?.recordToolCompleted(trace, {
            actionNumber, toolCallId: call.id, name: call.name, arguments: call.arguments,
            result: JSON.stringify({ actionNumber, ok: false, error: { message: errorMessage(error) } }), ok: false,
          });
          this.options.inspector?.finalizeRound(trace, signal.aborted ? "aborted" : "error");
          throw error;
        }
        signal.throwIfAborted();
        session.round += 1;
        if (report) return report;
      }
    } catch (error: unknown) {
      if (signal.aborted) return this.report(session, "interrupted", "Delegated step interrupted.");
      console.error("Action delegation failed:", error);
      return this.report(session, "failure", errorMessage(error));
    }
  }

  private async completeValidatedCall(session: ActionSession): Promise<{ response: LLMResponse; validated: ValidatedActionCall; trace: LLMRequestTrace }> {
    const signal = session.abort.signal;
    let correction: string | null = null;
    for (let attempt = 0; attempt <= this.options.maxResponseRetries; attempt += 1) {
      signal.throwIfAborted();
      if (this.options.executor.currentTask) throw new Error("Invariant violation: LLM called during a physical action.");
      let built = this.options.contextBuilder.build({
        delegation: session.delegation, lastTask: session.lastTask, lastResult: session.lastResult,
      });
      let trace: LLMRequestTrace = {
        generationId: session.trace?.generationId ?? session.id, phase: "actioner",
        reflection: session.trace?.delegation ?? session.id, round: session.round, attempt,
        wakeType: "delegated_step", permission: "action", contextSnapshot: built.snapshot,
      };
      const messages = await new ContextCompactor({
        llm: this.options.llm, inspector: this.options.inspector,
        temperature: this.options.temperature, reasoningEffort: this.options.reasoningEffort,
        maxTokens: this.options.maxTokens, maxRetries: this.options.maxResponseRetries,
        onRetry: async (_phase, retry) => { await this.options.onRetry?.("[Bot] Retrying context compression (" + retry + ")."); },
      }, this.options.contextSummaryPrompt, this.options.contextBudget).prepare({
        history: session.history,
        render: (messages, summary) => {
          built = this.options.contextBuilder.build({
            delegation: session.delegation, lastTask: session.lastTask, lastResult: session.lastResult, conversationSummary: summary,
          });
          return [...built.messages, ...messages];
        },
        tools: this.options.toolBridge.catalog.build(),
        generationId: trace.generationId, reflection: trace.reflection, round: session.round,
        phase: "actioner_context_summary", signal, requestTitle: session.delegation.userObjective,
      });
      trace = { ...trace, contextSnapshot: built.snapshot };
      this.options.inspector?.beginRound(trace);
      try {
        const response = await completeWithinBudget(this.options.llm, {
          messages: withValidationFeedback(messages, correction),
          tools: this.options.toolBridge.catalog.build(),
          temperature: this.options.temperature, reasoningEffort: this.options.reasoningEffort,
          maxTokens: this.options.maxTokens, signal, trace,
        });
        signal.throwIfAborted();
        if (response.finishReason === "length") throw new ModelResponseError("Response reached the token limit.");
        const calls = response.message.toolCalls ?? [];
        validateCallIds(calls);
        const validated = this.options.toolBridge.validateResponseCalls(calls);
        if (validated.kind === "action" && validated.task.capability === "build") {
          const selected = session.delegation.construction?.blueprint.blueprintId;
          const input = validated.task.input as { blueprintId: string };
          if (!selected || input.blueprintId !== selected) {
            throw new ModelResponseError(selected
              ? `Use the CURRENT selected blueprintId ${selected}. No build was executed.`
              : "No blueprint is selected for this request. Return the blocker with finish_step; ask_architect must run before construction.");
          }
        }
        // Reserve the final slot for a report instead of forcing a fabricated success.
        if (session.round >= this.maxToolCalls - 1 && validated.kind !== "finish") {
          throw new ModelResponseError("Delegation tool call limit reached (" + this.maxToolCalls + "). Return finish_step with the observed facts and any blocker; never claim unverified success.");
        }
        this.options.inspector?.annotate(trace, { decision: validated });
        return { response, validated, trace };
      } catch (error: unknown) {
        if (signal.aborted || !isModelResponseError(error)) {
          this.options.inspector?.finalizeRound(trace, signal.aborted ? "aborted" : "error");
          throw error;
        }
        correction = error.message;
        const { contextSnapshot: _context, ...metadata } = trace;
        writeTrace("llm.validation_error", { ...metadata, message: correction });
        this.options.inspector?.annotate(trace, { validationError: correction });
        this.options.inspector?.finalizeRound(trace, "invalid_response");
        if (attempt >= this.options.maxResponseRetries) {
          throw new ModelResponseError("Invalid action response after " + (attempt + 1) + " attempts: " + correction);
        }
        await this.options.onRetry?.("[Bot] Invalid action response. Retrying (" + (attempt + 1) + "/" + this.options.maxResponseRetries + "): " + correction);
      }
    }
    throw new ModelResponseError("Action response retries exhausted.");
  }

  private report(session: ActionSession, status: DelegatedActionReport["status"], message: string): DelegatedActionReport {
    return { status, message, outcomes: structuredClone(session.outcomes) };
  }
}

function validateCallIds(calls: readonly LLMToolCall[]): void {
  if (calls.some((call) => !call.id.trim()) || new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new ModelResponseError("Tool calls require unique, non-empty IDs.");
  }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
