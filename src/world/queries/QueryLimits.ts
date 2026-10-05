export const QUERY_LIMITS = { timeoutMs: 2_000, maxResultChars: 12_000, maxBlockRadius: 50 };

export interface QueryContext {
  readonly signal?: AbortSignal;
  /** Monotonic time, in performance.now() milliseconds. */
  readonly deadline?: number;
}

export class QueryExecutionError extends Error {
  constructor(readonly code: "QUERY_TIMEOUT" | "INTERRUPTED", message: string) { super(message); }
}

export function checkQueryBudget(context: QueryContext): void {
  context.signal?.throwIfAborted();
  if (context.deadline !== undefined && performance.now() >= context.deadline) {
    throw new QueryExecutionError("QUERY_TIMEOUT", "World query exceeded its work budget. Use a smaller search radius/count.");
  }
}
