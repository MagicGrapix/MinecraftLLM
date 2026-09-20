import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { ContainerSessionManager } from "../runtime/ContainerSessionManager";
import type { Capability, ExecutionContext } from "./Capability";

export interface CloseContainerInput {
  sessionId: string;
}

export interface CloseContainerOutput {
  sessionId: string;
  closed: true;
}

export class CloseContainerCapability
  implements Capability<CloseContainerInput, CloseContainerOutput>
{
  readonly name = "close_container";
  readonly inputSchema: z.ZodType<CloseContainerInput> = z
    .object({ sessionId: z.string().uuid() })
    .strict();

  constructor(private readonly sessions: ContainerSessionManager) {}

  async execute(
    input: CloseContainerInput,
    context: ExecutionContext,
  ): Promise<TaskResult<CloseContainerOutput>> {
    const resolved = this.sessions.resolve(input.sessionId);
    if (!resolved.ok) {
      return failure(
        resolved.reason === "mismatch"
          ? "WORLD_CHANGED"
          : "CONTAINER_NOT_OPEN",
        `Container session "${input.sessionId}" is ${resolved.reason}.`,
        { facts: { sessionId: input.sessionId } },
      );
    }

    context.signal.throwIfAborted();
    const closed = await this.sessions.close(input.sessionId);
    context.signal.throwIfAborted();
    if (!closed || context.runtime.bot.currentWindow !== null) {
      return failure(
        "ACTION_NOT_CONFIRMED",
        "The container window did not close cleanly.",
        { retryable: true, facts: { sessionId: input.sessionId } },
      );
    }

    return success({ sessionId: input.sessionId, closed: true });
  }
}
