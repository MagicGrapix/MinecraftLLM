export type QueryErrorCode =
  | "QUERY_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "OBSERVATION_UNAVAILABLE"
  | "QUERY_TIMEOUT"
  | "INTERRUPTED"
  | "RESULT_TOO_LARGE"
  | "INTERNAL_ERROR";

export interface QueryError {
  readonly code: QueryErrorCode;
  readonly message: string;
  readonly facts?: Record<string, unknown>;
}

export type QueryResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: QueryError };

export function querySuccess<T>(value: T): QueryResult<T> {
  return { ok: true, value };
}

export function queryFailure<T = never>(
  code: QueryErrorCode,
  message: string,
  facts?: Record<string, unknown>,
): QueryResult<T> {
  return {
    ok: false,
    error: facts ? { code, message, facts } : { code, message },
  };
}
