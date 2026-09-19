import type { z } from "zod";
import type { TaskResult } from "../execution/TaskResult";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";

export interface ExecutionContext {
  readonly runtime: MinecraftRuntime;
  readonly world: WorldQueries;
  readonly signal: AbortSignal;
}

export interface Capability<Input, Output> {
  readonly name: string;
  readonly inputSchema: z.ZodType<Input>;
  execute(
    input: Input,
    context: ExecutionContext,
  ): Promise<TaskResult<Output>>;
}
