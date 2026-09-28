import { z } from "zod";
import type { ChatIntentRouter } from "../chat/ChatIntentRouter";
import type { AgentInspector } from "../debug/AgentInspector";
import type {
  SequentialPlanRunner,
  SequentialTaskOutcome,
} from "../execution/SequentialPlanRunner";
import type { Task, TaskSpec } from "../execution/Task";
import type { TaskResult } from "../execution/TaskResult";
import type {
  LLMClient,
  LLMMessage,
  LLMRequestTrace,
  LLMResponse,
} from "../llm/LLMClient";
import { LLMError } from "../llm/LLMError";
import { parseJsonObjectText } from "../shared/helper";
import { writeTrace } from "../TraceLog";
import type { AgentDecision, AgentFinishStatus } from "./AgentDecision";
import {
  AgentContextBuilder,
  type AgentContextSnapshot,
  type AgentReflectionPhase,
} from "./AgentContextBuilder";
import type {
  AgentPermissionMode,
  AgentToolBridge,
  AgentToolResult,
} from "./AgentToolBridge";
import { MemoryUpdater } from "./MemoryUpdater";
import { ModelResponseError } from "./ModelResponseError";
import { MessageHistory, PINNED_MESSAGE_COUNT, withValidationFeedback, type ToolReplayMode } from "./MessageHistory";
import type { WorkingMemory } from "./WorkingMemory";

export type SequentialAgentMode =
  | "idle"
  | "thinking"
  | "executing"
  | "stopped";

export interface AgentRun {
  readonly id: number;
  readonly objective: string;
  kind: "unknown" | "question" | "action";
  state: Exclude<SequentialAgentMode, "idle">;
  remainingTasks: readonly TaskSpec[];
  currentTask: Task | null;
  lastTask: Task | null;
  lastResult: TaskResult | null;
  memory: string;
  consecutivePlansWithoutAction: number;
}

export interface SequentialAgentState {
  readonly mode: SequentialAgentMode;
  readonly run: AgentRun | null;
}

export interface DelegatedActionReport {
  readonly status: AgentFinishStatus | "interrupted";
  readonly message: string;
  readonly outcomes: readonly SequentialTaskOutcome[];
}

export interface DelegatedTraceContext {
  readonly generationId: number;
  readonly delegation: number;
}

interface SequentialAgentOptions {
  readonly llm: LLMClient;
  readonly intentRouter?: ChatIntentRouter;
  readonly contextBuilder: AgentContextBuilder;
  readonly toolBridge: AgentToolBridge;
  readonly runner: SequentialPlanRunner;
  readonly workingMemory: WorkingMemory;
  readonly memoryUpdater?: MemoryUpdater;
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
  readonly respond: (message: string, username?: string) => Promise<void>;
}

interface ReflectionResult {
  readonly response: LLMResponse;
  readonly context: AgentContextSnapshot;
  readonly toolResults: readonly AgentToolResult[];
  readonly decision?: AgentDecision;
  readonly message?: string;
}

const ReadonlyResponseSchema = z
  .object({ message: z.string().trim().min(1).max(2_000) })
  .strict();

export class SequentialAgent {
  private mode: SequentialAgentMode = "idle";
  private activeRun: AgentRun | null = null;
  private activeUsername: string | undefined;
  private activeAbort: AbortController | null = null;
  private processing: Promise<void> | null = null;
  private stopRequested = false;
  private shutdownRequested = false;
  private nextRunId = 0;
  private reflection = 0;
  private pendingOutcomeMemory: {
    runId: number;
    reflection: number;
    result: ReflectionResult;
  } | null = null;
  private delegated: {
    readonly resolve: (report: DelegatedActionReport) => void;
    readonly outcomes: SequentialTaskOutcome[];
  } | null = null;
  private delegatedTrace: DelegatedTraceContext | null = null;
  private readonly transcript: MessageHistory;
  private pendingDecision: { message: Extract<LLMMessage, { role: "assistant" }>; trace: LLMRequestTrace } | null = null;

  constructor(private readonly options: SequentialAgentOptions) {
    this.transcript = new MessageHistory(options.historyMaxMessages ?? 20, options.historyMaxChars ?? 30_000, options.toolReplayMode);
  }

  runDelegatedStep(
    objective: string,
    traceContext?: DelegatedTraceContext,
  ): Promise<DelegatedActionReport> {
    if (this.shutdownRequested || this.mode !== "idle" || !objective.trim()) {
      return Promise.reject(new Error("Action agent is unavailable."));
    }
    const run: AgentRun = {
      id: ++this.nextRunId,
      objective: objective.trim(),
      kind: "action",
      state: "thinking",
      remainingTasks: [],
      currentTask: null,
      lastTask: null,
      lastResult: null,
      memory: "",
      consecutivePlansWithoutAction: 0,
    };
    this.options.workingMemory.clear();
    this.transcript.clear();
    this.pendingDecision = null;
    this.delegatedTrace = traceContext ?? null;
    this.activeRun = run;
    this.mode = "thinking";
    this.stopRequested = false;
    this.reflection = 0;
    const report = new Promise<DelegatedActionReport>((resolve) => {
      this.delegated = { resolve, outcomes: [] };
    });
    const processing = this.processActionRun(run);
    const tracked = processing.finally(() => {
      if (this.processing === tracked) this.processing = null;
    });
    this.processing = tracked;
    return report;
  }

  state(): SequentialAgentState {
    return {
      mode: this.mode,
      run: this.activeRun ? cloneRun(this.activeRun) : null,
    };
  }

  submitUserMessage(
    username: string,
    text: string,
  ): void {
    if (this.shutdownRequested || this.mode !== "idle") return;
    const objective = text.trim();
    if (!objective) return;

    const run: AgentRun = {
      id: ++this.nextRunId,
      objective,
      kind: "unknown",
      state: "thinking",
      remainingTasks: [],
      currentTask: null,
      lastTask: null,
      lastResult: null,
      memory: this.options.workingMemory.read(),
      consecutivePlansWithoutAction: 0,
    };
    this.activeRun = run;
    this.activeUsername = username;
    this.mode = "thinking";
    this.stopRequested = false;
    this.reflection = 0;
    console.info("Sequential agent run started.", {
      runId: run.id,
      username,
      objective,
    });
    this.processing = this.processRun(run).finally(() => {
      if (this.processing) this.processing = null;
    });
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
    if (this.activeRun) this.activeRun.state = "stopped";
    this.activeAbort?.abort("Stopped by user.");
    this.options.runner.abortCurrent("Stopped by user.");
    await this.processing?.catch(() => undefined);
    if (this.delegated) {
      this.resolveDelegated("interrupted", "Action interrupted by user.");
      this.finishRun();
    }
    await this.options.respond("Bot stopped.", username);
  }

  requestResume(username: string): void {
    if (
      this.shutdownRequested ||
      this.mode !== "stopped" ||
      !this.activeRun
    ) {
      return;
    }
    void this.resume(username);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) {
      await this.processing?.catch(() => undefined);
      return;
    }
    this.shutdownRequested = true;
    this.stopRequested = true;
    this.activeAbort?.abort("Agent shutdown.");
    this.options.runner.abortCurrent("Agent shutdown.");
    await this.processing?.catch(() => undefined);
    if (this.delegated) this.resolveDelegated("interrupted", "Action agent shut down.");
  }

  private async resume(username: string): Promise<void> {
    await this.processing?.catch(() => undefined);
    const run = this.activeRun;
    if (
      !run ||
      this.shutdownRequested ||
      this.mode !== "stopped"
    ) {
      return;
    }
    this.activeUsername = username;
    this.stopRequested = false;
    this.mode = "thinking";
    run.state = "thinking";
    await this.options.respond("Resuming current run.", username);
    const resumed =
      run.kind === "action"
        ? this.processActionRun(run)
        : run.kind === "question"
          ? this.processQuestionRun(run)
          : this.processRun(run);
    this.processing = resumed.finally(() => {
      if (this.processing) this.processing = null;
    });
  }

  private async processRun(run: AgentRun): Promise<void> {
    const abort = new AbortController();
    this.activeAbort = abort;
    const intentTrace = this.trace(run, "intent", 0, 0, "intent", null);
    this.options.inspector?.beginRound(intentTrace);
    try {
      if (!this.options.intentRouter) throw new Error("Intent router is unavailable.");
      const intent = await this.options.intentRouter.route(
        run.objective,
        abort.signal,
        intentTrace,
      );
      abort.signal.throwIfAborted();
      this.options.inspector?.annotate(intentTrace, { decision: intent });
      this.options.inspector?.finalizeRound(intentTrace, "completed");

      if (intent.kind === "unclear") {
        await this.options.respond(
          "Can you clarify whether you want an explanation or an action?",
          this.activeUsername,
        );
        this.finishRun();
        return;
      }
      if (intent.kind === "action_request") {
        run.kind = "action";
        await this.processActionRun(run, abort);
      } else {
        run.kind = "question";
        await this.processQuestionRun(run, abort);
      }
    } catch (error: unknown) {
      this.options.inspector?.finalizeOpenRounds(
        run.id,
        this.stopRequested ? "aborted" : "error",
        errorMessage(error),
      );
      await this.handleRunError(run, error);
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private async processQuestionRun(
    run: AgentRun,
    existingAbort?: AbortController,
  ): Promise<void> {
    const abort = existingAbort ?? new AbortController();
    if (!existingAbort) this.activeAbort = abort;
    try {
      this.setMode(run, "thinking");
      const reflection = ++this.reflection;
      const result = await this.reflect(
        run,
        "question",
        "readonly",
        reflection,
        abort.signal,
      );
      await this.updateMemory(run, reflection, result, abort.signal);
      abort.signal.throwIfAborted();
      await this.options.respond(result.message!, this.activeUsername);
      this.finishRun();
    } catch (error: unknown) {
      await this.handleRunError(run, error);
    } finally {
      if (!existingAbort && this.activeAbort === abort) {
        this.activeAbort = null;
      }
    }
  }

  private async processActionRun(
    run: AgentRun,
    existingAbort?: AbortController,
  ): Promise<void> {
    const abort = existingAbort ?? new AbortController();
    if (!existingAbort) this.activeAbort = abort;
    try {
      while (!this.shutdownRequested && !this.stopRequested) {
        this.assertNoPhysicalAction();
        await this.commitPendingOutcomeMemory(run, abort.signal);
        this.setMode(run, "thinking");
        const phase: AgentReflectionPhase =
          run.lastResult === null ? "planning" : "review";
        const reflection = ++this.reflection;
        const result = await this.reflect(
          run,
          phase,
          "action",
          reflection,
          abort.signal,
        );
        const decision = result.decision!;

        if (
          decision.type === "set_plan" &&
          run.consecutivePlansWithoutAction >=
            (this.options.maxConsecutivePlansWithoutAction ?? 8)
        ) {
          throw new ModelResponseError(
            "The agent kept replacing its plan without executing a task.",
          );
        }
        await this.updateMemory(run, reflection, result, abort.signal);
        abort.signal.throwIfAborted();

        if (decision.type === "set_plan") {
          this.options.runner.setPlan(decision.tasks);
          run.remainingTasks = this.options.runner.remaining();
          run.consecutivePlansWithoutAction += 1;
          this.recordDecisionResult({ ok: true, value: { remainingPlan: run.remainingTasks } });
          continue;
        }
        if (decision.type === "finish_run") {
          this.options.runner.clear();
          run.remainingTasks = [];
          this.recordDecisionResult({ ok: true, value: { status: decision.status, message: decision.message } });
          if (this.delegated) {
            this.resolveDelegated(decision.status, decision.message);
          } else {
            await this.options.respond(decision.message, this.activeUsername);
          }
          this.finishRun();
          return;
        }

        if (this.options.runner.remaining().length === 0) {
          throw new ModelResponseError(
            "continue_plan requires a non-empty remaining plan.",
          );
        }
        this.setMode(run, "executing");
        const completion = this.options.runner.executeNext();
        run.currentTask = this.options.runner.currentTask;
        run.remainingTasks = this.options.runner.remaining();
        const outcome = await completion;
        if (!outcome) {
          throw new Error("The next sequential task disappeared.");
        }
        this.applyOutcome(run, outcome);
        this.recordDecisionResult({ task: outcome.task, result: outcome.result });
        run.consecutivePlansWithoutAction = 0;
        this.pendingOutcomeMemory = { runId: run.id, reflection, result };
        if (this.stopRequested) {
          this.setMode(run, "stopped");
          return;
        }
        await this.commitPendingOutcomeMemory(run, abort.signal);
      }
    } catch (error: unknown) {
      await this.handleRunError(run, error);
    } finally {
      if (!existingAbort && this.activeAbort === abort) {
        this.activeAbort = null;
      }
    }
  }

  private async reflect(
    run: AgentRun,
    phase: AgentReflectionPhase,
    permission: AgentPermissionMode,
    reflection: number,
    signal: AbortSignal,
  ): Promise<ReflectionResult> {
    const buildContext = () => this.options.contextBuilder.build({
      runId: run.id,
      phase,
      permission,
      objective: run.objective,
      workingMemory: this.options.workingMemory.read(),
      currentTask: run.currentTask,
      lastTask: run.lastTask,
      lastResult: run.lastResult,
      remainingPlan: this.options.runner.remaining(),
      currentMessage: phase === "question" ? run.objective : undefined,
      instruction: reflectionInstruction(phase),
    });
    let built = buildContext();
    const history = this.delegated ? this.transcript : new MessageHistory(this.options.historyMaxMessages ?? 20, this.options.historyMaxChars ?? 30_000, this.options.toolReplayMode);
    if (history.snapshot().messages.length === 0) {
      for (const message of built.messages.slice(PINNED_MESSAGE_COUNT)) history.append(message);
    }
    const toolResults: AgentToolResult[] = [];

    for (
      let round = 0;
      round <= this.options.maxToolRounds;
      round += 1
    ) {
      signal.throwIfAborted();
      this.assertNoPhysicalAction();
      if (round > 0) built = buildContext();
      const completion = await this.completeValidatedRound({
        run,
        phase,
        permission,
        reflection,
        round,
        messages: [...built.messages.slice(0, PINNED_MESSAGE_COUNT), ...history.snapshot().messages],
        context: built.snapshot,
        signal,
      });
      if (completion.kind === "message") {
        return {
          response: completion.response,
          context: built.snapshot,
          toolResults,
          message: completion.message,
        };
      }
      if (completion.kind === "decision") {
        this.pendingDecision = { message: completion.response.message, trace: completion.trace };
        return {
          response: completion.response,
          context: built.snapshot,
          toolResults,
          decision: completion.decision,
        };
      }

      try {
        const results: Extract<LLMMessage, { role: "tool" }>[] = [];
        for (const call of completion.calls) {
          const trace = completion.trace;
          this.options.inspector?.recordToolStarted(trace, {
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
          });
          const result = await this.options.toolBridge.executeRead(call);
          signal.throwIfAborted();
          toolResults.push(result);
          this.options.inspector?.recordToolCompleted(trace, {
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
            result: result.content,
            ok: result.ok,
          });
          results.push({
            role: "tool",
            toolCallId: result.toolCallId,
            content: result.content,
          });
        }
        history.appendExchange(completion.response.message, results);
        this.options.inspector?.finalizeRound(completion.trace, "completed");
      } catch (error: unknown) {
        this.options.inspector?.finalizeRound(completion.trace, signal.aborted ? "aborted" : "error");
        throw error;
      }
    }
    throw new ModelResponseError(
      `Reflection exceeded ${this.options.maxToolRounds} query rounds.`,
    );
  }

  private async completeValidatedRound(input: {
    readonly run: AgentRun;
    readonly phase: AgentReflectionPhase;
    readonly permission: AgentPermissionMode;
    readonly reflection: number;
    readonly round: number;
    readonly messages: readonly LLMMessage[];
    readonly context: AgentContextSnapshot;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: "message";
        readonly message: string;
        readonly response: LLMResponse;
      }
    | {
        readonly kind: "decision";
        readonly trace: LLMRequestTrace;
        readonly decision: AgentDecision;
        readonly response: LLMResponse;
      }
    | {
        readonly kind: "reads";
        readonly calls: readonly {
          readonly id: string;
          readonly name: string;
          readonly arguments: string;
        }[];
        readonly response: LLMResponse;
        readonly trace: LLMRequestTrace;
      }
  > {
    let correction: string | null = null;
    for (
      let attempt = 0;
      attempt <= this.options.maxResponseRetries;
      attempt += 1
    ) {
      input.signal.throwIfAborted();
      const trace = this.trace(
        input.run,
        input.phase,
        input.reflection,
        input.round,
        "reflection",
        input.context,
        attempt,
      );
      this.options.inspector?.beginRound(trace);
      try {
        const response = await this.options.llm.complete({
          messages: withValidationFeedback(input.messages, correction),
          tools: this.options.toolBridge.catalog.build(input.permission),
          responseFormat:
            input.permission === "readonly" ? "json_object" : undefined,
          temperature: this.options.temperature,
          reasoningEffort: this.options.reasoningEffort,
          maxTokens: this.options.maxTokens,
          signal: input.signal,
          trace,
        });
        input.signal.throwIfAborted();
        if (response.finishReason === "length") {
          throw new ModelResponseError(
            "Response reached the token limit.",
          );
        }
        const calls = response.message.toolCalls ?? [];
        if (calls.length === 0) {
          if (input.permission !== "readonly") {
            throw new ModelResponseError(
              "Action reflection must end with one decision tool call.",
            );
          }
          if (!response.message.content) {
            throw new ModelResponseError(
              "Readonly response must contain JSON content.",
            );
          }
          const parsed = ReadonlyResponseSchema.safeParse(
            parseReadonlyJson(response.message.content),
          );
          if (!parsed.success) {
            throw new ModelResponseError(
              formatIssues(parsed.error.issues),
            );
          }
          this.options.inspector?.annotate(trace, {
            decision: { type: "answer", message: parsed.data.message },
          });
          this.options.inspector?.finalizeRound(trace, "completed");
          return {
            kind: "message",
            message: parsed.data.message,
            response,
          };
        }

        const validated = this.options.toolBridge.validateResponseCalls(
          calls,
          input.permission,
        );
        if (validated.kind === "decision") {
          if (
            validated.decision.type === "continue_plan" &&
            this.options.runner.remaining().length === 0
          ) {
            throw new ModelResponseError(
              "continue_plan requires a non-empty remaining plan.",
            );
          }
          this.options.inspector?.annotate(trace, {
            decision: validated.decision,
          });
          return {
            kind: "decision",
            trace,
            decision: validated.decision,
            response,
          };
        }
        return {
          kind: "reads",
          calls: validated.calls,
          response,
          trace,
        };
      } catch (error: unknown) {
        if (
          input.signal.aborted ||
          !(error instanceof ModelResponseError)
        ) {
          this.options.inspector?.finalizeRound(trace, "error");
          throw error;
        }
        correction = error.message;
        this.options.inspector?.annotate(trace, {
          validationError: correction,
        });
        this.options.inspector?.finalizeRound(trace, "invalid_response");
        if (attempt >= this.options.maxResponseRetries) {
          throw new ModelResponseError(
            `Invalid agent response after ${attempt + 1} attempts: ${correction}`,
          );
        }
        await this.options.respond(
          `[Bot] Invalid agent response. Retrying (${attempt + 1}/${this.options.maxResponseRetries}).`,
          this.activeUsername,
        );
      }
    }
    throw new ModelResponseError("Agent response retries exhausted.");
  }

  private async updateMemory(
    run: AgentRun,
    reflection: number,
    result: ReflectionResult,
    signal: AbortSignal,
    round = 0,
  ): Promise<void> {
    if (!this.options.memoryUpdater) return;
    const oldMemory = this.options.workingMemory.read();
    await this.options.memoryUpdater.update({
      runId: run.id,
      reflection,
      round,
      oldMemory,
      context: result.context,
      agentResponse: result.response,
      toolResults: result.toolResults,
      ...(run.lastTask && run.lastResult
        ? {
            actionOutcome: {
              task: run.lastTask,
              result: run.lastResult,
            },
          }
        : {}),
      signal,
    });
    run.memory = this.options.workingMemory.read();
  }

  private async commitPendingOutcomeMemory(
    run: AgentRun,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = this.pendingOutcomeMemory;
    if (!pending || pending.runId !== run.id) return;
    await this.updateMemory(
      run,
      pending.reflection,
      pending.result,
      signal,
      1,
    );
    this.pendingOutcomeMemory = null;
  }

  private applyOutcome(
    run: AgentRun,
    outcome: SequentialTaskOutcome,
  ): void {
    if (this.delegated) {
      this.delegated.outcomes.push(outcome);
    }
    run.currentTask = null;
    run.lastTask = outcome.task;
    run.lastResult = outcome.result;
    run.remainingTasks = this.options.runner.remaining();
  }

  private async handleRunError(
    run: AgentRun,
    error: unknown,
  ): Promise<void> {
    this.recordDecisionResult({ ok: false, error: errorMessage(error) });
    if (this.stopRequested || this.shutdownRequested) {
      this.setMode(run, "stopped");
      return;
    }
    if (isAbort(error)) {
      this.setMode(run, "stopped");
      return;
    }
    console.error("Sequential agent run failed:", error);
    this.options.runner.clear();
    if (this.delegated) {
      this.resolveDelegated("failure", errorMessage(error));
      this.finishRun();
      return;
    }
    await this.options.respond(
      `[Bot] Run failed: ${errorMessage(error)}`,
      this.activeUsername,
    );
    this.finishRun();
  }

  private finishRun(): void {
    this.transcript.clear();
    this.pendingDecision = null;
    this.options.runner.clear();
    this.pendingOutcomeMemory = null;
    this.activeRun = null;
    this.delegatedTrace = null;
    this.activeUsername = undefined;
    this.mode = "idle";
    this.stopRequested = false;
  }

  private recordDecisionResult(result: unknown): void {
    const pending = this.pendingDecision;
    if (!pending) return;
    this.pendingDecision = null;
    const call = pending.message.toolCalls![0]!;
    const content = JSON.stringify(result);
    if (this.delegated) {
      this.transcript.appendExchange(pending.message, [{ role: "tool", toolCallId: call.id, content }]);
    }
    this.options.inspector?.recordToolStarted(pending.trace, { toolCallId: call.id, name: call.name, arguments: call.arguments });
    this.options.inspector?.recordToolCompleted(pending.trace, { toolCallId: call.id, name: call.name, arguments: call.arguments, result: content, ok: !(typeof result === "object" && result !== null && "ok" in result && result.ok === false) });
    this.options.inspector?.finalizeRound(pending.trace, "completed");
  }

  private resolveDelegated(
    status: DelegatedActionReport["status"],
    message: string,
  ): void {
    const delegated = this.delegated;
    if (!delegated) return;
    this.delegated = null;
    delegated.resolve({ status, message, outcomes: [...delegated.outcomes] });
  }

  private setMode(
    run: AgentRun,
    mode: Exclude<SequentialAgentMode, "idle">,
  ): void {
    this.mode = mode;
    run.state = mode;
    run.remainingTasks = this.options.runner.remaining();
  }

  private assertNoPhysicalAction(): void {
    if (this.options.runner.isExecuting) {
      throw new Error(
        "Invariant violation: LLM reflection started during a physical action.",
      );
    }
  }

  private trace(
    run: AgentRun,
    phase: LLMRequestTrace["phase"],
    reflection: number,
    round: number,
    wakeType: string,
    contextSnapshot: unknown,
    attempt = 0,
  ): LLMRequestTrace {
    const rolePhase = this.delegated && phase === "planning"
      ? "actioner_planning"
      : this.delegated && phase === "review"
        ? "actioner_review"
        : phase;
    return {
      generationId: this.delegatedTrace?.generationId ?? run.id,
      phase: rolePhase,
      reflection: this.delegatedTrace
        ? this.delegatedTrace.delegation * 1_000 + reflection
        : reflection,
      round,
      attempt,
      wakeType,
      permission: phase === "question" ? "readonly" : phase,
      ...(contextSnapshot === null
        ? {}
        : { contextSnapshot: structuredClone(contextSnapshot) }),
    };
  }
}

function parseReadonlyJson(content: string): unknown {
  try {
    return parseJsonObjectText(content);
  } catch (error: unknown) {
    throw new ModelResponseError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function reflectionInstruction(phase: AgentReflectionPhase): string {
  switch (phase) {
    case "question":
      return "Answer the current user question. Use read queries if needed.";
    case "planning":
      return "Inspect the current state and make exactly one terminal planning decision.";
    case "review":
      return "Review the latest TaskResult and current state, then make exactly one terminal decision.";
  }
}

function cloneRun(run: AgentRun): AgentRun {
  return structuredClone(run);
}

function formatIssues(
  issues: readonly { path: (string | number)[]; message: string }[],
): string {
  return issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof LLMError && error.code === "ABORTED")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
