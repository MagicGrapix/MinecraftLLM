import type { LLMMessage } from "../llm/LLMClient";
import { compactToolExchange } from "./ToolReplayFormatter";
import { promptNumbers } from "./PromptNumberFormatter";

export type ToolReplayMode = "native" | "compact";

interface Group { messages: LLMMessage[]; chat?: LLMMessage }

/** Chronological transcript. Nothing is evicted before a valid summary is committed. */
export class MessageHistory {
  private groups: Group[] = [];
  private activeUser: Group | undefined;
  private revision = 0;
  summary = "";

  constructor(readonly toolReplayMode: ToolReplayMode = "native") {}

  append(message: LLMMessage): void {
    if (message.role === "system" || message.role === "tool" ||
      (message.role === "assistant" && message.toolCalls?.length)) {
      throw new Error("Use appendExchange for tools; pinned context is assembled separately.");
    }
    const group = { messages: [structuredClone(message)], chat: structuredClone(message) };
    this.add(group);
    if (message.role === "user") this.activeUser = group;
  }

  appendExchange(message: Extract<LLMMessage, { role: "assistant" }>, results: readonly Extract<LLMMessage, { role: "tool" }>[]): void {
    const ids = message.toolCalls?.map((call) => call.id) ?? [];
    if (!ids.length || new Set(ids).size !== ids.length || ids.length !== results.length ||
      results.some((result, index) => result.toolCallId !== ids[index])) {
      throw new Error("Tool exchange must contain exactly one matching result per call, in order.");
    }
    const presentedResults = results.map((result) => {
      try {
        return { ...result, content: JSON.stringify(promptNumbers(JSON.parse(result.content))) };
      } catch {
        return result;
      }
    });
    const call = message.toolCalls?.[0];
    let chat: LLMMessage | undefined;
    if (call?.name === "reply" && ids.length === 1) {
      try {
        const result = JSON.parse(results[0]!.content);
        const args = JSON.parse(call.arguments);
        if (result.ok && result.value?.sent && typeof args.message === "string") {
          chat = { role: "assistant", content: args.message };
        }
      } catch { /* Not a successful player reply. */ }
    }
    this.add({ messages: structuredClone([message, ...presentedResults]), chat });
  }

  snapshot(): { messages: LLMMessage[] } {
    return { messages: structuredClone(this.groups.flatMap((g) => g.messages)) };
  }

  conversation(): { messages: LLMMessage[] } {
    return { messages: structuredClone(this.groups.flatMap((g) => g.chat ? [g.chat] : [])) };
  }

  clear(): void { this.groups = []; this.activeUser = undefined; this.summary = ""; this.revision++; }

  /** Keeps the active user request in place, and the latest exchange in full. */
  prepareCompaction(maxRemainingChars: number) {
    const remaining = [...this.groups];
    const removed: Group[] = [];
    const latest = this.groups.at(-1);
    for (const group of this.groups) {
      if (JSON.stringify(remaining.flatMap((g) => g.messages)).length <= maxRemainingChars) break;
      if (group === this.activeUser || group === latest) continue;
      removed.push(group);
      remaining.splice(remaining.indexOf(group), 1);
    }
    if (!removed.length) throw new Error("Context budget exceeded by protected input; narrow the request or tool output.");
    const revision = this.revision;
    return {
      messages: structuredClone(removed.flatMap((g) => g.messages)),
      remaining: structuredClone(remaining.flatMap((g) => g.messages)),
      commit: (summary: string) => {
        if (!summary.trim()) throw new Error("Cannot compact with an empty summary.");
        if (revision !== this.revision) throw new Error("History changed during compression.");
        this.groups = remaining;
        this.summary = summary;
        this.revision++;
      },
    };
  }

  private add(group: Group): void {
    if (this.toolReplayMode === "compact") {
      const previous = this.groups.at(-1);
      const assistant = previous?.messages[0];
      if (previous && assistant?.role === "assistant" && assistant.toolCalls?.length) {
        previous.messages = [compactToolExchange(assistant, previous.messages.slice(1) as Extract<LLMMessage, { role: "tool" }>[])];
      }
    }
    this.groups.push(group);
    this.revision++;
  }
}

/** Retry feedback belongs to the existing system message, not player history. */
export function withValidationFeedback(messages: readonly LLMMessage[], correction: string | null): readonly LLMMessage[] {
  if (!correction) return messages;
  const first = messages[0];
  if (first?.role !== "system") throw new Error("A pinned system message is required.");
  return [{ ...first, content: `${first.content}\n\nInternal validation feedback (not a player message): ${correction}. Retry the same task using the required response format. No action from the invalid response was executed.` }, ...messages.slice(1)];
}
