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

/** Local metadata never sent on the wire to the LLM provider. */
export interface LLMRequestTrace {
  readonly generationId: number;
  readonly phase: "summary" | "context_summary" | "actioner_context_summary" | "coordinator" | "planner" | "actioner";
  readonly reflection: number;
  readonly round: number;
  readonly attempt: number;
  readonly wakeType: string;
  readonly permission: string;
  readonly contextSnapshot?: unknown;
}

export interface LLMRequest {
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMTool[];
  readonly responseFormat?: "json_object";
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly trace?: LLMRequestTrace;
}

export interface LLMResponse {
  readonly message: Extract<LLMMessage, { role: "assistant" }>;
  readonly reasoning?: string;
  readonly finishReason: string | null;
  readonly raw?: unknown;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
