import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { toVec3 } from "../runtime/PositionAdapter";
import { errorMessage } from "../shared/helper";
import { BlockPositionSchema, type Position } from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

export interface DigInput {
  position: Position;
}

export interface DigOutput {
  position: Position;
  block: string;
  durationMs: number;
}

export class DigCapability implements Capability<DigInput, DigOutput> {
  readonly name = "dig";
  readonly inputSchema: z.ZodType<DigInput> = z
    .object({
      position: BlockPositionSchema,
    })
    .strict();

  async execute(
    input: DigInput,
    context: ExecutionContext,
  ): Promise<TaskResult<DigOutput>> {
    const bot = context.runtime.bot;
    const block = bot.blockAt(toVec3(input.position));

    if (!block || block.boundingBox === "empty") {
      return failure(
        "TARGET_NOT_FOUND",
        `No diggable block exists at (${input.position.x}, ${input.position.y}, ${input.position.z}).`,
        { retryable: false, facts: { position: input.position } },
      );
    }

    if (bot.targetDigBlock) {
      return failure("BLOCKED", "The bot is already digging another block.", {
        retryable: true,
        facts: { position: input.position },
      });
    }

    if (!bot.canDigBlock(block)) {
      return failure("OUT_OF_REACH", `Block "${block.name}" is out of reach.`, {
        retryable: true,
        facts: { block: block.name, position: input.position },
      });
    }

    const startedAt = Date.now();
    const stopDigging = (): void => bot.stopDigging();

    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", stopDigging, { once: true });

    try {
      await bot.dig(block);
      context.signal.throwIfAborted();

      return success({
        position: input.position,
        block: block.name,
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;

      const errorCode = expectedDigErrorCode(error);
      if (!errorCode) throw error;

      return failure(
        errorCode,
        `Could not finish digging "${block.name}": ${errorMessage(error)}`,
        {
          retryable: true,
          facts: { block: block.name, position: input.position },
        },
      );
    } finally {
      context.signal.removeEventListener("abort", stopDigging);
    }
  }
}

function expectedDigErrorCode(
  error: unknown,
): "BLOCKED" | "OUT_OF_REACH" | "WORLD_CHANGED" | null {
  const message = errorMessage(error);

  if (message.includes("dig time") && message.includes("Infinity")) {
    return "BLOCKED";
  }
  if (message === "Block not in view") {
    return "OUT_OF_REACH";
  }
  if (message === "Digging aborted") {
    return "WORLD_CHANGED";
  }
  return null;
}
