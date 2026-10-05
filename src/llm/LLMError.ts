export type LLMErrorCode =
  | "ABORTED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "CONTEXT_TOO_LARGE"
  | "INTERNAL_ERROR";

export class LLMError extends Error {
  constructor(
    readonly code: LLMErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
