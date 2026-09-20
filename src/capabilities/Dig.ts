import type { Bot } from "mineflayer";
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
  tool: string;
  estimatedDurationMs: number;
  waitedForGroundMs: number;
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
    const targetPosition = toVec3(input.position);
    const initialBlock = bot.blockAt(targetPosition);

    if (!initialBlock || initialBlock.boundingBox === "empty") {
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

    const expectedBlock = {
      name: initialBlock.name,
      stateId: initialBlock.stateId,
    };
    const waitedForGroundMs = await waitUntilGrounded(bot, context.signal);
    const block = bot.blockAt(targetPosition);

    if (!block || block.boundingBox === "empty") {
      return failure(
        "WORLD_CHANGED",
        `Block "${expectedBlock.name}" disappeared before digging started.`,
        {
          retryable: true,
          facts: { expectedBlock: expectedBlock.name, position: input.position },
        },
      );
    }

    if (
      block.name !== expectedBlock.name ||
      block.stateId !== expectedBlock.stateId
    ) {
      return failure(
        "WORLD_CHANGED",
        `Expected "${expectedBlock.name}" but found "${block.name}" before digging started.`,
        {
          retryable: true,
          facts: {
            expectedBlock: expectedBlock.name,
            actualBlock: block.name,
            position: input.position,
          },
        },
      );
    }

    if (!bot.canDigBlock(block)) {
      return failure("OUT_OF_REACH", `Block "${block.name}" is out of reach.`, {
        retryable: true,
        facts: { block: block.name, position: input.position },
      });
    }

    const tool = bot.heldItem?.name ?? "hand";
    const estimatedDurationMs = bot.digTime(block);
    const startedAt = Date.now();
    const stopDigging = (): void => bot.stopDigging();

    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", stopDigging, { once: true });

    try {
      // Raycasting makes Mineflayer prove that a visible face of this exact block
      // is under the bot's crosshair before it sends the digging packet.
      await bot.dig(block, false, "raycast");
      context.signal.throwIfAborted();

      // Mineflayer updates its local world optimistically when its timer ends.
      // Give the server two ticks to reject the dig and restore the block.
      await waitForTicks(bot, 2, context.signal);
      const blockAfterDig = bot.blockAt(targetPosition);

      if (blockAfterDig && blockAfterDig.boundingBox !== "empty") {
        const sameBlock = blockAfterDig.name === expectedBlock.name;
        return failure(
          sameBlock ? "BLOCKED" : "WORLD_CHANGED",
          sameBlock
            ? `The server did not accept digging "${expectedBlock.name}".`
            : `The target changed from "${expectedBlock.name}" to "${blockAfterDig.name}" while digging.`,
          {
            retryable: true,
            facts: {
              expectedBlock: expectedBlock.name,
              actualBlock: blockAfterDig.name,
              position: input.position,
            },
          },
        );
      }

      return success({
        position: input.position,
        block: block.name,
        tool,
        estimatedDurationMs,
        waitedForGroundMs,
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

async function waitUntilGrounded(
  bot: Bot,
  signal: AbortSignal,
): Promise<number> {
  const startedAt = Date.now();

  while (!bot.entity.onGround) {
    await waitForTicks(bot, 1, signal);
  }

  return Date.now() - startedAt;
}

async function waitForTicks(
  bot: Bot,
  ticks: number,
  signal: AbortSignal,
): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }

  signal.throwIfAborted();
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
