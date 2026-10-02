import type { AgentInspector } from "../debug/AgentInspector";
import type { SequentialPlanRunner, SequentialTaskOutcome } from "../execution/SequentialPlanRunner";
import type { Task } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";
import type { LLMClient, LLMMessage, LLMRequestTrace, LLMResponse, LLMToolCall } from "../llm/LLMClient";
import type { ActionContextBuilder } from "./ActionContextBuilder";
import type { ActionDelegation, DelegatedActionReport, DelegatedTraceContext } from "./ActionTypes";
import type { AgentToolBridge } from "./AgentToolBridge";
import { MessageHistory, withValidationFeedback, type ToolReplayMode } from "./MessageHistory";
import { ModelResponseError } from "./ModelResponseError";

type ActionMode = "idle" | "thinking" | "executing" | "stopped";
type ValidatedCalls = ReturnType<AgentToolBridge["validateResponseCalls"]>;

interface ActionAgentOptions {
  readonly llm: LLMClient;
  readonly contextBuilder: ActionContextBuilder;
  readonly toolBridge: AgentToolBridge;
  readonly runner: SequentialPlanRunner;
  readonly maxToolRounds: number;
  readonly maxResponseRetries: number;
  readonly maxConsecutivePlansWithoutAction?: number;
  readonly temperature: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
  readonly maxTokens: number;
  readonly historyMaxMessages?: number;
  readonly historyMaxChars?: number;
  readonly toolReplayMode?: ToolReplayMode;
  readonly inspector?: AgentInspector;
  readonly onRetry?: (message: string) => Promise<void>;
}

interface ActionSession {
  readonly id: number;
  readonly delegation: ActionDelegation;
  readonly trace?: DelegatedTraceContext;
  readonly abort: AbortController;
  readonly history: MessageHistory;
  readonly outcomes: SequentialTaskOutcome[];
  description: string;
  lastTask: Task | null;
  lastResult: TaskResult | null;
  round: number;
  readRounds: number;
  plansWithoutAction: number;
}

/** One prompt, one private conversation, one awaited tool at a time. */
export class ActionAgent {
  private mode: ActionMode = "idle";
  private session: ActionSession | null = null;
  private processing: Promise<DelegatedActionReport> | null = null;
  private shutdownRequested = false;
  private nextId = 0;

  constructor(private readonly options: ActionAgentOptions) {}

  runDelegatedStep(delegation: ActionDelegation, trace?: DelegatedTraceContext): Promise<DelegatedActionReport> {
    if (this.shutdownRequested || this.session || this.options.runner.isExecuting) {
      return Promise.reject(new Error("Action agent is unavailable."));
    }
    if (!delegation.instruction.trim() || !delegation.step.title.trim() || !delegation.step.successCriteria.trim() ||
      !Number.isInteger(delegation.step.step) || delegation.step.step < 1) {
      return Promise.reject(new Error("A numbered step, success criterion and instruction are required."));
    }
    const session: ActionSession = {
      id: ++this.nextId, delegation: structuredClone(delegation), trace,
      abort: new AbortController(),
      // Pin the coordinator instruction too: it must survive transcript eviction.
      history: new MessageHistory(this.options.historyMaxMessages ?? 20, this.options.historyMaxChars ?? 30_000, this.options.toolReplayMode, 3),
      outcomes: [], description: "", lastTask: null, lastResult: null,
      round: 0, readRounds: 0, plansWithoutAction: 0,
    };
    this.options.runner.clear();
    this.session = session;
    this.mode = "thinking";
    console.info("Action delegation started.", { request: trace?.generationId ?? session.id, step: delegation.step.step, instruction: delegation.instruction });
    const tracked = this.process(session).finally(() => {
      session.history.clear();
      this.options.runner.clear();
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
        step: structuredClone(session.delegation.step), localPlan: session.description,
        remainingTasks: this.options.runner.remaining(), currentTask: this.options.runner.currentTask,
        lastTask: structuredClone(session.lastTask), lastResult: structuredClone(session.lastResult),
      } : null,
    };
  }

  async requestStop(_username?: string): Promise<void> {
    if (!this.session) return;
    this.mode = "stopped";
    this.session.abort.abort("Stopped by user.");
    this.options.runner.abortCurrent("Stopped by user.");
    // Wait for the actual capability to settle, not just for the LLM abort.
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
        const calls = response.message.toolCalls!;
        const results: Extract<LLMMessage, { role: "tool" }>[] = [];
        let report: DelegatedActionReport | undefined;
        try {
          for (const call of calls) {
            this.options.inspector?.recordToolStarted(trace, { toolCallId: call.id, name: call.name, arguments: call.arguments });
            let content: string;
            let ok: boolean;
            if (signal.aborted) {
              content = JSON.stringify({ ok: false, error: { code: "INTERRUPTED", message: "Delegation stopped; tool was not executed." } });
              ok = false;
            } else if (validated.kind === "reads") {
              const read = await this.options.toolBridge.executeRead(call);
              content = read.content;
              ok = read.ok;
            } else {
              const decision = validated.decision;
              if (decision.type === "set_plan") {
                this.options.runner.setPlan(decision.tasks);
                session.description = decision.description;
                session.plansWithoutAction += 1;
                content = JSON.stringify({ ok: true, value: { description: session.description, remainingPlan: this.options.runner.remaining() } });
                ok = true;
              } else if (decision.type === "continue_plan") {
                this.mode = "executing";
                const outcome = await this.options.runner.executeNext();
                if (!outcome) throw new Error("The next sequential task disappeared.");
                session.outcomes.push(outcome);
                session.lastTask = outcome.task;
                session.lastResult = outcome.result;
                session.plansWithoutAction = 0;
                content = JSON.stringify(outcome);
                ok = outcome.result.ok;
              } else {
                this.options.runner.clear();
                report = this.report(session, decision.status, decision.message);
                content = JSON.stringify({ ok: true, value: { status: decision.status, message: decision.message } });
                ok = true;
              }
            }
            results.push({ role: "tool", toolCallId: call.id, content });
            this.options.inspector?.recordToolCompleted(trace, { toolCallId: call.id, name: call.name, arguments: call.arguments, result: content, ok });
          }
          session.history.appendExchange(response.message, results);
          this.options.inspector?.finalizeRound(trace, signal.aborted ? "aborted" : "completed");
        } catch (error: unknown) {
          const failedCall = calls[results.length];
          if (failedCall) {
            this.options.inspector?.recordToolCompleted(trace, {
              toolCallId: failedCall.id, name: failedCall.name, arguments: failedCall.arguments,
              result: JSON.stringify({ ok: false, error: { message: errorMessage(error) } }), ok: false,
            });
          }
          this.options.inspector?.finalizeRound(trace, signal.aborted ? "aborted" : "error");
          throw error;
        }
        // Preserve an interrupted physical TaskResult before returning to the coordinator.
        signal.throwIfAborted();
        if (report) return report;
        session.readRounds = validated.kind === "reads" ? session.readRounds + 1 : 0;
        session.round += 1;
      }
    } catch (error: unknown) {
      if (signal.aborted) return this.report(session, "interrupted", "Delegated step interrupted.");
      console.error("Action delegation failed:", error);
      return this.report(session, "failure", errorMessage(error));
    }
  }

  private async completeValidatedCall(session: ActionSession): Promise<{ response: LLMResponse; validated: ValidatedCalls; trace: LLMRequestTrace }> {
    const signal = session.abort.signal;
    let correction: string | null = null;
    for (let attempt = 0; attempt <= this.options.maxResponseRetries; attempt += 1) {
      signal.throwIfAborted();
      if (this.options.runner.isExecuting) throw new Error("Invariant violation: LLM called during a physical action.");
      const built = this.options.contextBuilder.build({
        delegation: session.delegation, planDescription: session.description,
        remainingPlan: this.options.runner.remaining(), lastTask: session.lastTask, lastResult: session.lastResult,
      });
      const trace: LLMRequestTrace = {
        generationId: session.trace?.generationId ?? session.id, phase: "actioner",
        reflection: session.trace?.delegation ?? session.id, round: session.round, attempt,
        wakeType: "delegated_step", permission: "action", contextSnapshot: built.snapshot,
      };
      this.options.inspector?.beginRound(trace);
      try {
        const response = await this.options.llm.complete({
          messages: withValidationFeedback([...built.messages, ...session.history.snapshot().messages], correction),
          tools: this.options.toolBridge.catalog.build(),
          temperature: this.options.temperature, reasoningEffort: this.options.reasoningEffort,
          maxTokens: this.options.maxTokens, signal, trace,
        });
        signal.throwIfAborted();
        if (response.finishReason === "length") throw new ModelResponseError("Response reached the token limit.");
        const calls = response.message.toolCalls ?? [];
        validateCallIds(calls);
        const validated = this.options.toolBridge.validateResponseCalls(calls);
        if (validated.kind === "reads" && session.readRounds >= this.options.maxToolRounds) {
          throw new ModelResponseError("Query round limit reached. Choose set_plan, continue_plan or finish_step using the observed facts.");
        }
        if (validated.kind === "decision") {
          if (validated.decision.type === "continue_plan" && !this.options.runner.remaining().length) {
            throw new ModelResponseError("continue_plan requires a non-empty remaining plan. An empty queue is not proof of success.");
          }
          if (validated.decision.type === "set_plan" && session.plansWithoutAction >= (this.options.maxConsecutivePlansWithoutAction ?? 8)) {
            throw new ModelResponseError("Repeated plan replacements without an action. Continue the current plan or report the blocker with finish_step.");
          }
          this.options.inspector?.annotate(trace, { decision: validated.decision });
        }
        return { response, validated, trace };
      } catch (error: unknown) {
        if (signal.aborted || !(error instanceof ModelResponseError)) {
          this.options.inspector?.finalizeRound(trace, signal.aborted ? "aborted" : "error");
          throw error;
        }
        correction = error.message;
        this.options.inspector?.annotate(trace, { validationError: correction });
        this.options.inspector?.finalizeRound(trace, "invalid_response");
        if (attempt >= this.options.maxResponseRetries) {
          throw new ModelResponseError(`Invalid action response after ${attempt + 1} attempts: ${correction}`);
        }
        await this.options.onRetry?.(`[Bot] Invalid action response. Retrying (${attempt + 1}/${this.options.maxResponseRetries}): ${correction}`);
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
