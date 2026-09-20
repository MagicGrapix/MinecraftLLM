export type TaskErrorCode =
  | "TARGET_NOT_FOUND"
  | "NO_PATH"
  | "OUT_OF_REACH"
  | "MISSING_ITEM"
  | "RECIPE_NOT_FOUND"
  | "NOT_CONSUMABLE"
  | "CONTAINER_NOT_OPEN"
  | "ENTITY_NOT_FOUND"
  | "ACTION_NOT_CONFIRMED"
  | "BLOCKED"
  | "TIMEOUT"
  | "WORLD_CHANGED"
  | "INTERRUPTED"
  | "INVALID_ARGUMENT"
  | "INTERNAL_ERROR";

export interface TaskError {
  code: TaskErrorCode;
  message: string;
  retryable: boolean;
  facts?: Record<string, unknown>;
}

export type TaskResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: TaskError };

export function success<T>(value: T): TaskResult<T> {
  return { ok: true, value };
}

export function failure<T = never>(
  code: TaskErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    facts?: Record<string, unknown>;
  } = {},
): TaskResult<T> {
  const error: TaskError = {
    code,
    message,
    retryable: options.retryable ?? false,
  };

  if (options.facts !== undefined) {
    error.facts = options.facts;
  }

  return { ok: false, error };
}
