import { PLANNER_MAX_TOOL_CALLS } from "../config";
import type { ToolCallJournal } from "../execution/ToolCallJournal";
import { completeWithinBudget } from "../llm/InputBudget";
import { LLMError } from "../llm/LLMError";
import type { LLMMessage, LLMRequestTrace, LLMTool } from "../llm/LLMClient";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { RecipeTools, RecipeToolOutcome } from "../recipes/RecipeTools";
import { invalidToolArguments, parseToolArguments } from "../shared/ToolArgumentFeedback";
import { writeTrace } from "../TraceLog";
import { ContextCompactor, type ContextBudget } from "./ContextCompactor";
import { MessageHistory, withValidationFeedback } from "./MessageHistory";
import type { StructuredRoleOptions } from "./StructuredRoleCall";
import { toJsonSchema } from "./ToolCatalogBuilder";
import { PlannerResultSchema, type PlanStep } from "./WorkflowState";

export interface PlannerReport {
  readonly steps: PlanStep[];
  readonly recipeCoverage: {
    readonly consulted: readonly string[];
    readonly unavailable: readonly { item: string; code: string }[];
  };
}
interface PlannerOptions extends StructuredRoleOptions {
  readonly recipes: RecipeTools;
  readonly journal: ToolCallJournal;
  readonly contextSummaryPrompt: PromptTemplate;
  readonly contextBudget?: ContextBudget;
  readonly maxCalls?: number;
}

/** Each invocation owns a fresh conversation; only submit_plan hands a validated checklist back. */
export class PlannerAgent {
  readonly definitions: readonly LLMTool[];
  private readonly maxCalls: number;
  constructor(private readonly options: PlannerOptions) {
    this.maxCalls = options.maxCalls ?? PLANNER_MAX_TOOL_CALLS;
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1) throw new Error("Planner maxCalls must be a positive integer.");
    this.definitions = [...options.recipes.definitions, {
      name: "submit_plan",
      description: "Does: Return the final high-level checklist to the coordinator.\nSuccess: The checklist format is valid; ends this delegation.\nLimits: Does not execute or prove completion of any step.\nNotes: Include quantities, station and observable success criteria. Invalid input returns feedback for correction.",
      parameters: toJsonSchema(PlannerResultSchema),
    }];
  }

  async run(input: {
    conversation: readonly LLMMessage[];
    conversationSummary: string;
    objective: string;
    generationId: number;
    reflection: number;
    signal: AbortSignal;
    render: (messages: readonly LLMMessage[], summary: string) => { messages: readonly LLMMessage[]; context: unknown };
  }): Promise<PlannerReport> {
    const history = new MessageHistory("native");
    const consulted = new Set<string>();
    const unavailable = new Map<string, string>();
    const compactor = new ContextCompactor(this.options, this.options.contextSummaryPrompt, this.options.contextBudget);
    let correction: string | null = null;
    let invalidAttempts = 0;
    let trace: LLMRequestTrace | undefined;
    try {
      history.summary = input.conversationSummary;
      for (const message of input.conversation) history.append(message);
      for (let round = 0; round < this.maxCalls; round++) {
        trace = undefined;
        input.signal.throwIfAborted();
        let context: unknown;
        const messages = await compactor.prepare({
          history, tools: this.definitions, generationId: input.generationId, reflection: input.reflection,
          round, phase: "planner_context_summary", signal: input.signal, requestTitle: input.objective,
          render: (recent, summary) => {
            const rendered = input.render(recent, summary);
            context = rendered.context;
            return withValidationFeedback(rendered.messages, correction);
          },
        });
        trace = { generationId: input.generationId, reflection: input.reflection, round,
          attempt: invalidAttempts, phase: "planner", wakeType: "delegation", permission: "planning", contextSnapshot: context };
        this.options.inspector?.beginRound(trace);
        let response;
        try {
          response = await completeWithinBudget(this.options.llm, {
            messages, tools: this.definitions, signal: input.signal, trace,
            temperature: this.options.temperature, reasoningEffort: this.options.reasoningEffort, maxTokens: this.options.maxTokens,
          });
        } catch (error) {
          if (!(error instanceof LLMError) || error.code !== "INVALID_RESPONSE") throw error;
          correction = error.message;
        }
        input.signal.throwIfAborted();
        const call = response?.message.toolCalls?.[0];
        if (!response || response.finishReason === "length" || response.message.toolCalls?.length !== 1 || !call?.id?.trim()) {
          correction = !response ? correction! : response.finishReason === "length"
            ? "Output was truncated. Nothing was executed. Return a shorter response with exactly one tool call."
            : "Return exactly one native tool call: search_recipes, read_recipe or submit_plan. Text alone does not submit a plan.";
          this.options.inspector?.annotate(trace, { validationError: correction });
          this.options.inspector?.finalizeRound(trace, "invalid_response");
          trace = undefined;
          if (++invalidAttempts > this.options.maxRetries) throw new Error(`Planner validation retries exhausted: ${correction}`);
          await this.options.onRetry?.("planner", invalidAttempts, correction);
          continue;
        }
        correction = null;
        const actionNumber = this.options.journal.start(call.name, false, {
          agent: "planner", generationId: input.generationId, toolCallId: call.id, arguments: call.arguments,
        });
        this.options.inspector?.recordToolStarted(trace, { actionNumber, toolCallId: call.id, name: call.name, arguments: call.arguments });
        let accepted: { steps: PlanStep[] } | undefined;
        let outcome: RecipeToolOutcome;
        let invalid = false;
        try {
          const raw = parseToolArguments(call.name, call.arguments);
          if (call.name === "submit_plan") {
            const parsed = PlannerResultSchema.safeParse(raw);
            if (!parsed.success) throw new Error(invalidToolArguments(call.name, raw, parsed.error.issues, PlannerResultSchema));
            accepted = parsed.data;
            outcome = { result: { ok: true, value: accepted }, feedback: `Plan accepted: ${accepted.steps.length} steps. Returning to the coordinator.` };
          } else {
            if (!this.options.recipes.schema(call.name)) throw new Error(`Unknown planner tool "${call.name}". Use search_recipes, read_recipe or submit_plan; capabilities belong to the action agent.`);
            outcome = this.options.recipes.execute(call.name, raw);
            invalid = !outcome.result.ok && outcome.result.error.code === "INVALID_ARGUMENT";
            if (call.name === "read_recipe" && typeof raw.item === "string" && !invalid) {
              if (outcome.result.ok) { consulted.add(`${raw.item}#${raw.variant ?? 1}`); unavailable.delete(raw.item); }
              else unavailable.set(raw.item, outcome.result.error.code);
            }
          }
        } catch (error) {
          invalid = true;
          const message = error instanceof Error ? error.message : String(error);
          outcome = { result: { ok: false, error: { code: "INVALID_ARGUMENT", message } }, feedback: `Error INVALID_ARGUMENT: ${message}` };
        }
        const content = JSON.stringify({ ...outcome.result, actionNumber });
        this.options.journal.complete(actionNumber, outcome.result.ok, content);
        this.options.inspector?.recordToolCompleted(trace, { actionNumber, toolCallId: call.id, name: call.name,
          arguments: call.arguments, result: content, ok: outcome.result.ok });
        writeTrace("planner.tool_result", { generationId: input.generationId, round, actionNumber, call, ...outcome });
        history.appendExchange(response.message, [{ role: "tool", toolCallId: call.id, content: `Action #${actionNumber}\n${outcome.feedback}` }]);
        if (accepted) this.options.inspector?.annotate(trace, { decision: accepted });
        this.options.inspector?.finalizeRound(trace, input.signal.aborted ? "aborted"
          : !accepted && round === this.maxCalls - 1 ? "tool_round_limit" : "completed");
        trace = undefined;
        input.signal.throwIfAborted();
        if (accepted) {
          return { ...accepted, recipeCoverage: { consulted: [...consulted], unavailable: [...unavailable].map(([item, code]) => ({ item, code })) } };
        }
        if (invalid) {
          if (++invalidAttempts > this.options.maxRetries) throw new Error(`Planner validation retries exhausted: ${outcome.feedback}`);
          await this.options.onRetry?.("planner", invalidAttempts, outcome.feedback);
        } else invalidAttempts = 0;
      }
      throw new Error("Planner call limit reached without a valid submit_plan; previous checklist preserved.");
    } catch (error) {
      if (trace) {
        this.options.inspector?.recordError(trace, error instanceof Error ? error.message : String(error));
        this.options.inspector?.finalizeRound(trace, input.signal.aborted ? "aborted" : "error");
      }
      throw error;
    } finally { history.clear(); }
  }
}
