export type InspectorRoundStatus =
  | "in_progress"
  | "completed"
  | "superseded"
  | "aborted"
  | "token_limit_discarded"
  | "tool_round_limit"
  | "invalid_response"
  | "error";

export interface InspectorToolExecution {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly result?: string;
  readonly ok?: boolean;
}

export interface InspectorPresentation {
  readonly requestTitle: string;
  readonly agentLabel: string;
  readonly stepLabel?: string;
  readonly activity: string;
  readonly outcome: string;
  readonly failed: boolean;
}

export interface InspectorRound extends InspectorPresentation {
  readonly id: string;
  readonly timestamp: number;
  /** Start order, independent of completion order and wall-clock precision. */
  readonly sequence: number;
  readonly callIndex: number;
  readonly generationId: number;
  readonly phase: import("../llm/LLMClient").LLMRequestTrace["phase"];
  readonly reflection: number;
  readonly round: number;
  readonly attempt: number;
  readonly wakeType: string;
  readonly permission: string;
  readonly status: InspectorRoundStatus;
  readonly contextSnapshot?: unknown;
  readonly decision?: unknown;
  readonly validationError?: string;
  readonly request?: {
    readonly model: string;
    readonly messages: unknown[];
    readonly tools: unknown[];
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly reasoningEffort?: string;
    readonly responseFormat?: string;
  };
  readonly requestBody?: Record<string, unknown>;
  readonly metrics?: {
    readonly messageCount: number;
    readonly messageChars: number;
    readonly toolCount: number;
    readonly toolSchemaChars: number;
    readonly estimatedInputChars: number;
  };
  readonly response?: {
    readonly content: string | null;
    readonly reasoning?: string;
    readonly toolCalls: unknown[];
    readonly finishReason: string | null;
    readonly usage?: {
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly totalTokens?: number;
    };
  };
  readonly rawResponse?: unknown;
  readonly toolExecutions: readonly InspectorToolExecution[];
  readonly error?: string;
}

export interface InspectorRoundSummary extends InspectorPresentation {
  readonly id: string;
  readonly timestamp: number;
  readonly sequence: number;
  readonly callIndex: number;
  readonly generationId: number;
  readonly phase: InspectorRound["phase"];
  readonly reflection: number;
  readonly round: number;
  readonly attempt: number;
  readonly wakeType: string;
  readonly permission: string;
  readonly status: InspectorRoundStatus;
  readonly preview: string;
  readonly messageCount?: number;
  readonly toolCount?: number;
  readonly toolExecutionCount: number;
  readonly finishReason?: string | null;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface InspectorStatus {
  readonly enabled: true;
  readonly sessionId: string;
  readonly maxRounds: number;
  readonly finalizedCount: number;
  readonly inProgressCount: number;
  readonly latestRoundId: string | null;
  readonly inProgress: readonly {
    readonly id: string;
    readonly generationId: number;
    readonly callIndex: number;
    readonly phase: InspectorRound["phase"];
    readonly reflection: number;
    readonly round: number;
    readonly attempt: number;
  }[];
}
