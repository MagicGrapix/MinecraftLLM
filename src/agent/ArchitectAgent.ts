import { ARCHITECT_LIMITS, BLUEPRINT_LIMITS } from "../building/BuildingConfig";
import type { AgentInspector } from "../debug/AgentInspector";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { completeWithinBudget } from "../llm/InputBudget";
import type { LLMClient, LLMMessage, LLMRequestTrace } from "../llm/LLMClient";
import { LLMError } from "../llm/LLMError";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import { writeTrace } from "../TraceLog";
import { ArchitectTools, type ArchitectReport } from "./ArchitectTools";
import { ContextCompactor, type ContextBudget } from "./ContextCompactor";
import { MessageHistory, withValidationFeedback } from "./MessageHistory";

export interface ArchitectDelegation {
  readonly userRequest: string;
  readonly instruction: string;
  readonly constraints?: readonly string[];
  /** Optional factual terrain/inventory notes, not a limit to available stock. */
  readonly observations?: string;
  readonly conversation?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
}

export interface ArchitectOptions {
  readonly llm: LLMClient;
  readonly tools: ArchitectTools;
  readonly prompt: PromptTemplate;
  readonly contextSummaryPrompt: PromptTemplate;
  readonly inspector?: AgentInspector;
  readonly maxCalls?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
  readonly contextBudget?: ContextBudget;
}

/** One private conversation per delegation. No workflow state and no physical execution. */
export class ArchitectAgent {
  private active?: { controller: AbortController; promise: Promise<TaskResult<ArchitectReport>> };
  private nextGenerationId = 0;
  private readonly maxCalls: number;
  private readonly compactor: ContextCompactor;

  constructor(private readonly options: ArchitectOptions) {
    this.maxCalls = options.maxCalls ?? ARCHITECT_LIMITS.maxCalls;
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1) throw new Error("Architect maxCalls must be a positive integer.");
    this.compactor = new ContextCompactor({
      llm: options.llm, inspector: options.inspector,
      maxTokens: options.maxTokens ?? ARCHITECT_LIMITS.maxTokens,
      maxRetries: ARCHITECT_LIMITS.summaryRetries,
      temperature: options.temperature ?? 0.2, reasoningEffort: options.reasoningEffort,
    }, options.contextSummaryPrompt, options.contextBudget);
  }

  run(delegation: ArchitectDelegation, input: {
    signal?: AbortSignal; generationId?: number; reflection?: number;
  } = {}): Promise<TaskResult<ArchitectReport>> {
    if (this.active) return Promise.resolve(failure("BLOCKED", "An Architect delegation is already running."));
    if (!delegation.instruction.trim() || !delegation.userRequest.trim()) {
      return Promise.resolve(failure("INVALID_ARGUMENT", "Architect requires a user request and a delegation instruction."));
    }
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    const generationId = input.generationId ?? ++this.nextGenerationId;
    this.nextGenerationId = Math.max(this.nextGenerationId, generationId);
    const startedAt = Date.now();
    const promise = this.process(structuredClone(delegation), generationId, input.reflection ?? 0, signal)
      .then(result => {
        writeTrace("architect.finished", { generationId, durationMs: Date.now() - startedAt, result });
        return result;
      })
      .finally(() => { this.active = undefined; });
    this.active = { controller, promise };
    return promise;
  }

  /** Returns only after generation/storage has settled; never releases a still-running writer. */
  async requestStop(): Promise<void> {
    const active = this.active;
    active?.controller.abort("Architect stopped");
    await active?.promise;
  }

  private async process(delegation: ArchitectDelegation, generationId: number, reflection: number,
    signal: AbortSignal): Promise<TaskResult<ArchitectReport>> {
    const history = new MessageHistory("native");
    let trace: LLMRequestTrace | undefined;
    let calls = 0;
    try {
      signal.throwIfAborted();
      for (const message of delegation.conversation ?? []) history.append(message);
      history.append({ role: "user", content: delegation.userRequest });
      const system = this.options.prompt.render({
        instruction: delegation.instruction, constraints: JSON.stringify(delegation.constraints ?? []),
        observations: delegation.observations ?? "None supplied.",
        minecraft_version: this.options.tools.catalog.minecraftVersion,
        limits: JSON.stringify(BLUEPRINT_LIMITS),
        supported_materials: JSON.stringify(this.options.tools.supportedMaterials()),
        max_calls: this.maxCalls,
      });
      let correction: string | null = null;
      for (let round = 0; round < this.maxCalls; round++) {
        trace = undefined;
        signal.throwIfAborted();
        const messages = await this.compactor.prepare({
          history, tools: this.options.tools.definitions, generationId, reflection, round,
          phase: "architect_context_summary", signal, requestTitle: delegation.userRequest,
          render: (recent, summary): readonly LLMMessage[] => withValidationFeedback([
            { role: "system", content: system },
            { role: "assistant", content: `Previous conversation summary: ${summary || "empty. No earlier conversation has been compacted yet."}` },
            ...recent,
          ], correction),
        });
        trace = { generationId, reflection, round, attempt: 0, phase: "architect", wakeType: "delegation",
          permission: "blueprint_design", contextSnapshot: { objective: delegation.userRequest, instruction: delegation.instruction } };
        this.options.inspector?.beginRound(trace);
        calls++;
        console.info("Architect LLM call started.", { generationId, call: calls, maxCalls: this.maxCalls });
        const response = await completeWithinBudget(this.options.llm, {
          messages, tools: this.options.tools.definitions, signal, trace,
          temperature: this.options.temperature ?? 0.2, reasoningEffort: this.options.reasoningEffort,
          maxTokens: this.options.maxTokens ?? ARCHITECT_LIMITS.maxTokens,
        });
        signal.throwIfAborted();
        if (response.finishReason === "length") {
          this.options.inspector?.finalizeRound(trace, "token_limit_discarded");
          return failure("ACTION_NOT_CONFIRMED", "Architect response reached the output token limit; nothing from it was executed.", {
            facts: { reason: "TRUNCATED_RESPONSE", calls },
          });
        }
        const call = response.message.toolCalls?.[0];
        if (response.message.toolCalls?.length !== 1 || !call?.id?.trim()) {
          correction = "Return exactly one native tool call with a nonempty call id: lookup_material or submit_blueprint. Text alone does not submit a blueprint.";
          this.options.inspector?.annotate(trace, { validationError: correction });
          this.options.inspector?.finalizeRound(trace, "invalid_response");
          writeTrace("architect.invalid_response", { generationId, round, response, correction });
          continue;
        }
        correction = null;
        this.options.inspector?.recordToolStarted(trace, { toolCallId: call.id, name: call.name, arguments: call.arguments });
        const outcome = await this.options.tools.execute(call, signal);
        this.options.inspector?.recordToolCompleted(trace, {
          toolCallId: call.id, name: call.name, arguments: call.arguments,
          result: JSON.stringify(outcome.result), ok: outcome.result.ok,
        });
        writeTrace("architect.tool_result", { generationId, round, call, ...outcome });
        // A published immutable file may survive cancellation; it is not handed off as accepted.
        if (signal.aborted) {
          this.options.inspector?.finalizeRound(trace, "aborted");
          return failure("INTERRUPTED", "Architect stopped.", { facts: { calls,
            ...(outcome.accepted ? { savedBlueprintId: outcome.accepted.blueprintId } : {}) } });
        }
        history.appendExchange(response.message, [{ role: "tool", toolCallId: call.id, content: JSON.stringify(outcome.result) }]);
        this.options.inspector?.finalizeRound(trace, outcome.fatal ? "error"
          : !outcome.accepted && round === this.maxCalls - 1 ? "tool_round_limit" : "completed");
        console.info("Architect tool completed.", { tool: call.name, ok: outcome.result.ok });
        if (outcome.accepted) return success(outcome.accepted);
        if (outcome.fatal && !outcome.result.ok) return outcome.result;
      }
      return failure("ACTION_NOT_CONFIRMED", "Architect call limit reached without an accepted blueprint.", {
        facts: { reason: "ARCHITECT_CALL_LIMIT", calls },
      });
    } catch (error: unknown) {
      const interrupted = signal.aborted || error instanceof LLMError && error.code === "ABORTED";
      const message = error instanceof Error ? error.message : String(error);
      if (trace) {
        this.options.inspector?.recordError(trace, message);
        this.options.inspector?.finalizeRound(trace, interrupted ? "aborted" : "error");
      }
      writeTrace("architect.error", { generationId, calls, interrupted, message });
      return failure(interrupted ? "INTERRUPTED" : error instanceof LLMError && error.code === "TIMEOUT" ? "TIMEOUT" : "INTERNAL_ERROR",
        interrupted ? "Architect stopped." : message, {
          facts: { reason: error instanceof LLMError ? error.code : "ARCHITECT_ERROR", calls },
        });
    } finally {
      history.clear();
    }
  }
}
