import type { LLMMessage, LLMRequestTrace } from "../llm/LLMClient";
import type { CoordinatorTools } from "./CoordinatorTools";
import { withValidationFeedback } from "./MessageHistory";
import { ModelResponseError, isModelResponseError } from "./ModelResponseError";
import type { StructuredRoleOptions } from "./StructuredRoleCall";
import { writeTrace } from "../TraceLog";

export async function callCoordinator(input: {
  options: StructuredRoleOptions;
  tools: CoordinatorTools;
  generationId: number;
  reflection: number;
  messages: readonly LLMMessage[];
  context: unknown;
  signal: AbortSignal;
}) {
  let correction: string | null = null;
  for (let attempt = 0; attempt <= input.options.maxRetries; attempt += 1) {
    input.signal.throwIfAborted();
    const trace: LLMRequestTrace = {
      generationId: input.generationId, reflection: input.reflection, round: 0,
      attempt, phase: "coordinator", wakeType: "coordinator", permission: "coordination",
      contextSnapshot: input.context,
    };
    input.options.inspector?.beginRound(trace);
    try {
      const response = await input.options.llm.complete({
        messages: withValidationFeedback(input.messages, correction),
        tools: input.tools.catalog(),
        temperature: input.options.temperature, reasoningEffort: input.options.reasoningEffort,
        maxTokens: input.options.maxTokens, signal: input.signal, trace,
      });
      input.signal.throwIfAborted();
      if (response.finishReason === "length") throw new ModelResponseError("Response reached the token limit.");
      const calls = response.message.toolCalls ?? [];
      if (calls.length !== 1 || !calls[0]!.id) throw new ModelResponseError("Return exactly one native tool call, not a JSON/text decision or parallel calls.");
      const call = calls[0]!;
      const parsed = input.tools.parse(call);
      input.options.inspector?.annotate(trace, { decision: parsed });
      // The caller finalizes the round after the tool result has been recorded.
      return { trace, call, parsed, message: response.message };
    } catch (error: unknown) {
      const issue = error instanceof Error ? error.message : String(error);
      if (isModelResponseError(error)) {
        const { contextSnapshot: _context, ...metadata } = trace;
        writeTrace("llm.validation_error", { ...metadata, message: issue });
      }
      input.options.inspector?.annotate(trace, { validationError: issue });
      input.options.inspector?.finalizeRound(trace, input.signal.aborted ? "aborted" : isModelResponseError(error) ? "invalid_response" : "error");
      if (input.signal.aborted || !isModelResponseError(error)) throw error;
      if (attempt === input.options.maxRetries) throw new Error(`coordinator failed after ${attempt + 1} attempts: ${issue}`);
      correction = issue;
      await input.options.onRetry?.("coordinator", attempt + 1, issue);
    }
  }
  throw new Error("Coordinator exhausted retries.");
}
