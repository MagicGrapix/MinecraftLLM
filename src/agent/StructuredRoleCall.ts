import type { z } from "zod";
import type { AgentInspector } from "../debug/AgentInspector";
import type { LLMClient, LLMMessage, LLMRequestTrace } from "../llm/LLMClient";
import { LLMError } from "../llm/LLMError";
import { parseJsonObjectText } from "../shared/helper";
import { withValidationFeedback } from "./MessageHistory";
import { writeTrace } from "../TraceLog";
import { completeWithinBudget } from "../llm/InputBudget";

export interface StructuredRoleOptions {
  readonly llm: LLMClient;
  readonly inspector?: AgentInspector;
  readonly temperature: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
  readonly maxTokens: number;
  readonly maxRetries: number;
  readonly onRetry?: (phase: string, attempt: number, issue: string) => Promise<void>;
}

export async function callStructuredRole<T>(input: {
  readonly options: StructuredRoleOptions;
  readonly schema: z.ZodType<T>;
  readonly phase: "planner" | "summary" | "context_summary" | "actioner_context_summary";
  readonly generationId: number;
  readonly reflection: number;
  readonly round?: number;
  readonly messages: readonly LLMMessage[];
  readonly context: unknown;
  readonly signal: AbortSignal;
}): Promise<T> {
  let correction: string | null = null;
  for (let attempt = 0; attempt <= input.options.maxRetries; attempt += 1) {
    input.signal.throwIfAborted();
    const trace: LLMRequestTrace = {
      generationId: input.generationId,
      phase: input.phase,
      reflection: input.reflection,
      round: input.round ?? 0,
      attempt,
      wakeType: input.phase,
      permission: input.phase,
      contextSnapshot: input.context,
    };
    input.options.inspector?.beginRound(trace);
    try {
      const response = await completeWithinBudget(input.options.llm, {
        messages: withValidationFeedback(input.messages, correction),
        responseFormat: "json_object",
        temperature: input.options.temperature,
        reasoningEffort: input.options.reasoningEffort,
        maxTokens: input.options.maxTokens,
        signal: input.signal,
        trace,
      });
      input.signal.throwIfAborted();
      if (response.finishReason === "length") throw new Error("Response reached the token limit.");
      if (!response.message.content || response.message.toolCalls?.length) {
        throw new Error("Expected one JSON response without tool calls.");
      }
      const parsed = input.schema.safeParse(parseJsonObjectText(response.message.content));
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      }
      input.options.inspector?.annotate(trace, { decision: parsed.data });
      input.options.inspector?.finalizeRound(trace, "completed");
      return parsed.data;
    } catch (error: unknown) {
      if (input.signal.aborted) {
        input.options.inspector?.finalizeRound(trace, "aborted");
        throw error;
      }
      if (error instanceof LLMError && error.code !== "INVALID_RESPONSE") {
        input.options.inspector?.annotate(trace, { validationError: error.message });
        input.options.inspector?.finalizeRound(trace, "error");
        throw error;
      }
      correction = error instanceof Error ? error.message : String(error);
      const { contextSnapshot: _context, ...metadata } = trace;
      writeTrace("llm.validation_error", { ...metadata, message: correction });
      input.options.inspector?.annotate(trace, { validationError: correction });
      input.options.inspector?.finalizeRound(trace, "invalid_response");
      if (attempt === input.options.maxRetries) {
        throw new Error(`${input.phase} failed after ${attempt + 1} attempts: ${correction}`);
      }
      await input.options.onRetry?.(input.phase, attempt + 1, correction);
    }
  }
  throw new Error(`${input.phase} exhausted retries.`);
}
