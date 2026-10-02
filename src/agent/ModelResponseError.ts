import { LLMError } from "../llm/LLMError";

export function isModelResponseError(error: unknown): error is Error {
  return error instanceof ModelResponseError ||
    (error instanceof LLMError && error.code === "INVALID_RESPONSE");
}

export class ModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResponseError";
  }
}
