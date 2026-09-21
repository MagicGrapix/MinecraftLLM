import type { LLMMessage } from "../llm/LLMClient";

interface ConversationTurn {
  readonly messages: readonly LLMMessage[];
  readonly serializedChars: number;
}

export class ConversationHistory {
  private readonly turns: ConversationTurn[] = [];

  constructor(
    readonly maxTurns = 6,
    readonly maxSerializedChars = 16_000,
  ) {
    if (maxTurns <= 0 || maxSerializedChars <= 0) {
      throw new Error("ConversationHistory limits must be positive.");
    }
  }

  appendTurn(messages: readonly LLMMessage[]): boolean {
    if (messages.length === 0) return false;
    validateAtomicToolProtocol(messages);
    const cloned = structuredClone(messages);
    const serializedChars = JSON.stringify(cloned).length;
    if (serializedChars > this.maxSerializedChars) return false;

    this.turns.push({ messages: cloned, serializedChars });
    this.trim();
    return true;
  }

  messages(): readonly LLMMessage[] {
    return this.turns.flatMap((turn) => structuredClone(turn.messages));
  }

  groups(): readonly (readonly LLMMessage[])[] {
    return this.turns.map((turn) => structuredClone(turn.messages));
  }

  turnCount(): number {
    return this.turns.length;
  }

  private trim(): void {
    let characters = this.turns.reduce(
      (total, turn) => total + turn.serializedChars,
      0,
    );
    while (
      this.turns.length > this.maxTurns ||
      characters > this.maxSerializedChars
    ) {
      const removed = this.turns.shift();
      if (!removed) break;
      characters -= removed.serializedChars;
    }
  }
}

function validateAtomicToolProtocol(messages: readonly LLMMessage[]): void {
  let pendingIds: Set<string> | null = null;
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (pendingIds?.size) {
        throw new Error(
          "Conversation turn contains nested unresolved tool calls.",
        );
      }
      pendingIds = new Set(message.toolCalls.map((call) => call.id));
      if (pendingIds.size !== message.toolCalls.length) {
        throw new Error("Conversation turn contains duplicate tool call ids.");
      }
      continue;
    }
    if (message.role === "tool") {
      if (!pendingIds?.delete(message.toolCallId)) {
        throw new Error(
          `Orphan tool result "${message.toolCallId}" in conversation turn.`,
        );
      }
      if (pendingIds.size === 0) pendingIds = null;
      continue;
    }
    if (pendingIds?.size) {
      throw new Error(
        "Tool call results must immediately follow their assistant message.",
      );
    }
  }
  if (pendingIds?.size) {
    throw new Error("Conversation turn is missing tool results.");
  }
}
