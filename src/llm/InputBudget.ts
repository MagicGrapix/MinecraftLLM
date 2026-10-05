import { CONTEXT_BUDGET } from "../config";
import type { LLMClient, LLMMessage, LLMRequest, LLMTool } from "./LLMClient";
import { LLMError } from "./LLMError";

/** Input estimate, not a tokenizer or Ollama num_ctx. Output has its own budget. */
export function estimateInputTokens(messages: readonly LLMMessage[], tools: readonly LLMTool[] = [], charsPerToken = CONTEXT_BUDGET.charsPerToken): number {
  return Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length + 256 + messages.length * 16) / charsPerToken);
}

export function assertInputBudget(request: Pick<LLMRequest, "messages" | "tools">): void {
  const estimated = estimateInputTokens(request.messages, request.tools);
  if (estimated >= CONTEXT_BUDGET.compactAtTokens) {
    throw new LLMError("CONTEXT_TOO_LARGE", `Estimated input ${estimated} tokens reaches the ${CONTEXT_BUDGET.compactAtTokens}-token limit. Request not sent; reduce protected context or compact its history.`);
  }
}

/** Also guards fake/custom clients used by agents; the transport repeats this final check. */
export function completeWithinBudget(client: LLMClient, request: LLMRequest) {
  assertInputBudget(request);
  return client.complete(request);
}
