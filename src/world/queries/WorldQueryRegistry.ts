import type { z } from "zod";
import { errorMessage } from "../../shared/helper";
import type { WorldQueries } from "../WorldQueries";
import {
  queryFailure,
  type QueryResult,
} from "./QueryResult";
import type {
  WorldQuery,
  WorldQuerySummary,
} from "./WorldQuery";

interface RegisteredWorldQuery {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  execute(
    input: unknown,
    world: WorldQueries,
  ): Promise<QueryResult<unknown>>;
}

export class WorldQueryRegistry {
  private readonly queries = new Map<string, RegisteredWorldQuery>();

  constructor(private readonly world: WorldQueries) {}

  register<Input, Output>(query: WorldQuery<Input, Output>): void {
    if (this.queries.has(query.name)) {
      throw new Error(`World query "${query.name}" is already registered.`);
    }

    this.queries.set(query.name, {
      name: query.name,
      description: query.description,
      inputSchema: query.inputSchema as z.ZodType<unknown>,
      execute: (input, world) => query.execute(input as Input, world),
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

  async execute(name: string, input: unknown): Promise<QueryResult> {
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
        `Invalid input for world query "${name}".`,
        { issues: parsed.error.issues },
      );
    }

    try {
      return await query.execute(parsed.data, this.world);
    } catch (error: unknown) {
      return queryFailure(
        "INTERNAL_ERROR",
        errorMessage(error),
        { query: name },
      );
    }
  }
}
