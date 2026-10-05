import type { z } from "zod";
import type { TaskResult } from "../execution/TaskResult";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";

export interface ExecutionContext {
  readonly taskId?: string;
  /** Small partial state included in cancellation/errors; never releases the physical lock. */
  readonly reportProgress?: (facts: Record<string, unknown>) => void;
  readonly runtime: MinecraftRuntime;
  readonly world: WorldQueries;
  readonly signal: AbortSignal;
  readonly deferCancellationUntil: (operation: Promise<unknown>) => void;
}

export interface Capability<Input, Output> {
  readonly name: string;
  readonly description?: string;
  readonly defaultTimeoutMs?: number;
  readonly inputSchema: z.ZodType<Input>;
  execute(
    input: Input,
    context: ExecutionContext,
  ): Promise<TaskResult<Output>>;
}
