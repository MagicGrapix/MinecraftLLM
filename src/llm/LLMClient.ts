export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type LLMMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly toolCalls?: readonly LLMToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };

export interface LLMTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface LLMRequest {
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMTool[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface LLMResponse {
  readonly message: Extract<LLMMessage, { role: "assistant" }>;
  readonly finishReason: string | null;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
