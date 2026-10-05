import type { z } from "zod";
import { errorMessage } from "../../shared/helper";
import { invalidToolArguments } from "../../shared/ToolArgumentFeedback";
import type { WorldQueries } from "../WorldQueries";
import { checkQueryBudget, QUERY_LIMITS, QueryExecutionError, type QueryContext } from "./QueryLimits";
import {
  queryFailure,
  type QueryResult,
} from "./QueryResult";
import type {
  WorldQuery,
  WorldQuerySummary,
} from "./WorldQuery";

export interface RegisteredWorldQuery {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  execute(
    input: unknown,
    world: WorldQueries,
    context?: QueryContext,
  ): Promise<QueryResult<unknown>>;
}

export class WorldQueryRegistry {
  private readonly queries = new Map<string, RegisteredWorldQuery>();
  private frozen = false;

  freeze(): void { this.frozen = true; }

  constructor(private readonly world: WorldQueries) {}

  register<Input, Output>(query: WorldQuery<Input, Output>): void {
    if (this.frozen) throw new Error("World query registry is frozen; register tools before runtime assembly.");
    if (this.queries.has(query.name)) {
      throw new Error(`World query "${query.name}" is already registered.`);
    }

    this.queries.set(query.name, {
      name: query.name,
      description: query.description,
      inputSchema: query.inputSchema as z.ZodType<unknown>,
      execute: (input, world, context) => query.execute(input as Input, world, context),
    });
  }

  has(name: string): boolean {
    return this.queries.has(name);
  }

  list(): readonly WorldQuerySummary[] {
    return [...this.queries.values()].map(({ name, description }) => ({
      name,
      description,
    }));
  }

  get(name: string): RegisteredWorldQuery | undefined {
    return this.queries.get(name);
  }

  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<QueryResult> {
    const query = this.queries.get(name);
    if (!query) {
      return queryFailure(
        "QUERY_NOT_FOUND",
        `Unknown world query "${name}".`,
        { name },
      );
    }

    const parsed = query.inputSchema.safeParse(input);
    if (!parsed.success) {
      return queryFailure(
        "INVALID_ARGUMENT",
        invalidToolArguments(name, input, parsed.error.issues, query.inputSchema),
        { issues: parsed.error.issues },
      );
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(new QueryExecutionError("INTERRUPTED", "World query interrupted."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const deadline = performance.now() + QUERY_LIMITS.timeoutMs;
    const timer = setTimeout(() => controller.abort(new QueryExecutionError("QUERY_TIMEOUT", "World query exceeded its time budget.")), QUERY_LIMITS.timeoutMs);
    let rejectOnAbort: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      const interruption = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      const result = await Promise.race([
        query.execute(parsed.data, this.world, { signal: controller.signal, deadline }), interruption,
      ]);
      checkQueryBudget({ signal: controller.signal, deadline });
      if (JSON.stringify(result).length > QUERY_LIMITS.maxResultChars) {
        return queryFailure("RESULT_TOO_LARGE", "Query result is too large; reduce count or radius.", { query: name, maxResultChars: QUERY_LIMITS.maxResultChars });
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof QueryExecutionError) return queryFailure(error.code, error.message, { query: name });
      return queryFailure(
        "INTERNAL_ERROR",
        errorMessage(error),
        { query: name },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
    }
  }
}
