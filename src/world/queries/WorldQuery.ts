import type { z } from "zod";
import type { WorldQueries } from "../WorldQueries";
import type { QueryResult } from "./QueryResult";
import type { QueryContext } from "./QueryLimits";

export interface WorldQuery<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  execute(
    input: Input,
    world: WorldQueries,
    context?: QueryContext,
  ): Promise<QueryResult<Output>>;
}

export interface WorldQuerySummary {
  readonly name: string;
  readonly description: string;
}
