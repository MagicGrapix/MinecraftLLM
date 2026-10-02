import type { LLMMessage } from "../llm/LLMClient";
import { compactToolExchange } from "./ToolReplayFormatter";
import { promptNumbers } from "./PromptNumberFormatter";

export const PINNED_MESSAGE_COUNT = 2;
export type ToolReplayMode = "native" | "compact";

/** A rolling transcript. Tool calls and all their results are one eviction unit. */
export class MessageHistory {
  private groups: LLMMessage[][] = [];
  private omitted = 0;

  constructor(readonly maxMessages = 20, readonly maxChars = 30_000, readonly toolReplayMode: ToolReplayMode = "native", readonly pinnedMessageCount = PINNED_MESSAGE_COUNT) {
    if (!Number.isInteger(pinnedMessageCount) || pinnedMessageCount < 1 ||
      !Number.isInteger(maxMessages) || maxMessages < pinnedMessageCount + 2 || maxChars < 1) {
      throw new Error("History requires pinned context, a tool exchange, and a positive character budget.");
    }
  }

  append(message: LLMMessage): void {
    if (message.role === "system" || message.role === "tool" ||
      (message.role === "assistant" && message.toolCalls?.length)) {
      throw new Error("Use appendExchange for tools; pinned context is assembled separately.");
    }
    this.add([message]);
  }

  appendExchange(message: Extract<LLMMessage, { role: "assistant" }>, results: readonly Extract<LLMMessage, { role: "tool" }>[]): void {
    const ids = message.toolCalls?.map((call) => call.id) ?? [];
    if (!ids.length || new Set(ids).size !== ids.length || ids.length !== results.length ||
      results.some((result, index) => result.toolCallId !== ids[index])) {
      throw new Error("Tool exchange must contain exactly one matching result per call, in order.");
    }
    const presentedResults = results.map((result, index) => {
      // Schemas are exact execution contracts, not world-state presentation.
      if (message.toolCalls![index]!.name === "get_capability_schemas") return result;
      try {
        return { ...result, content: JSON.stringify(promptNumbers(JSON.parse(result.content))) };
      } catch {
        return result;
      }
    });
    this.add([message, ...presentedResults]);
  }

  snapshot(): { messages: LLMMessage[]; omitted: number } {
    return { messages: structuredClone(this.groups.flat()), omitted: this.omitted };
  }

  clear(): void { this.groups = []; this.omitted = 0; }

  private add(group: LLMMessage[]): void {
    if (this.toolReplayMode === "compact") {
      const previous = this.groups.at(-1);
      const assistant = previous?.[0];
      if (previous?.length && assistant?.role === "assistant" && assistant.toolCalls?.length) {
        this.groups[this.groups.length - 1] = [compactToolExchange(assistant, previous.slice(1) as Extract<LLMMessage, { role: "tool" }>[])];
      }
    }
    this.groups.push(structuredClone(group));
    // Reserve pinned context. Never slice JSON or tool pairs.
    while (this.groups.length > 0 && (this.groups.flat().length > this.maxMessages - this.pinnedMessageCount ||
      JSON.stringify(this.groups.flat()).length > this.maxChars)) {
      this.omitted += this.groups.shift()!.length;
    }
  }
}

/** Retry feedback belongs to the existing system message, not player history. */
export function withValidationFeedback(messages: readonly LLMMessage[], correction: string | null): readonly LLMMessage[] {
  if (!correction) return messages;
  const first = messages[0];
  if (first?.role !== "system") throw new Error("A pinned system message is required.");
  return [{ ...first, content: `${first.content}\n\nInternal validation feedback (not a player message): ${correction}. Retry the same task using the required response format. No action from the invalid response was executed.` }, ...messages.slice(1)];
}
