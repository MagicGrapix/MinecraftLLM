import { z } from "zod";
import { CONTEXT_BUDGET } from "../config";
import type { LLMMessage, LLMTool } from "../llm/LLMClient";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import { writeTrace } from "../TraceLog";
import type { MessageHistory } from "./MessageHistory";
import { callStructuredRole, type StructuredRoleOptions } from "./StructuredRoleCall";

export type ContextBudget = typeof CONTEXT_BUDGET;

/** Approximation only; includes serialized messages, schemas and protocol overhead. */
export function estimateInputTokens(messages: readonly LLMMessage[], tools: readonly LLMTool[] = [], charsPerToken = CONTEXT_BUDGET.charsPerToken): number {
  return Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length + 256 + messages.length * 16) / charsPerToken);
}

export class ContextCompactor {
  constructor(
    private readonly options: StructuredRoleOptions,
    private readonly prompt: PromptTemplate,
    private readonly budget: ContextBudget = CONTEXT_BUDGET,
  ) {
    if (!(budget.charsPerToken > 0 && budget.targetTokens > 0 &&
      budget.targetTokens < budget.compactAtTokens && budget.summaryMaxChars > 0)) {
      throw new Error("Invalid context compression budget.");
    }
  }

  async prepare(input: {
    history: MessageHistory;
    render: (messages: readonly LLMMessage[], summary: string) => readonly LLMMessage[];
    tools?: readonly LLMTool[];
    generationId: number;
    reflection: number;
    round?: number;
    phase?: "context_summary" | "actioner_context_summary";
    requestTitle?: string;
    signal: AbortSignal;
  }): Promise<readonly LLMMessage[]> {
    const { history, render, tools, signal } = input;
    const estimate = (messages: readonly LLMMessage[]) => estimateInputTokens(messages, tools, this.budget.charsPerToken);
    const current = render(history.snapshot().messages, history.summary);
    const before = estimate(current);
    if (before < this.budget.compactAtTokens) return current;

    const fixed = estimate(render([], "")) * this.budget.charsPerToken;
    const candidate = history.prepareCompaction(
      this.budget.targetTokens * this.budget.charsPerToken - fixed - this.budget.summaryMaxChars - 512,
    );
    // A huge system prompt, request or latest result cannot be fixed by discarding older history.
    if (estimate(render(candidate.remaining, "x".repeat(this.budget.summaryMaxChars))) >= this.budget.compactAtTokens) {
      throw new Error("Protected context exceeds the input budget; no history was discarded.");
    }
    console.info("Compacting context.", { estimatedInputTokens: before, targetTokens: this.budget.targetTokens });
    const { summary } = await callStructuredRole({
      options: this.options,
      schema: z.object({ summary: z.string().trim().min(1).max(this.budget.summaryMaxChars) }).strict(),
      phase: input.phase ?? "context_summary", generationId: input.generationId, reflection: input.reflection, round: input.round,
      signal, context: { estimatedInputTokens: before, currentMessage: input.requestTitle ?? current.filter((message) => message.role === "user").at(-1)?.content },
      messages: [{ role: "system", content: this.prompt.render({
        max_chars: this.budget.summaryMaxChars,
        summary_input: JSON.stringify({ previousSummary: history.summary, olderMessages: candidate.messages }),
      }) }],
    });
    signal.throwIfAborted();
    const messages = render(candidate.remaining, summary);
    if (estimate(messages) >= this.budget.compactAtTokens) throw new Error("Compression did not free enough context; history preserved.");
    candidate.commit(summary);
    writeTrace("context.compacted", { generationId: input.generationId, before, after: estimate(messages), summary });
    return messages;
  }
}
