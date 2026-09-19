import type { z } from "zod";
import type { WorldQueries } from "../WorldQueries";
import type { QueryResult } from "./QueryResult";

export interface WorldQuery<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  execute(
    input: Input,
    world: WorldQueries,
  ): Promise<QueryResult<Output>>;
}

export interface WorldQuerySummary {
  readonly name: string;
  readonly description: string;
}
