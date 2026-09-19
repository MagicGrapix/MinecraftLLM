import { goals } from "mineflayer-pathfinder";
import { z } from "zod";
import {
  failure,
  success,
  type TaskErrorCode,
  type TaskResult,
} from "../execution/TaskResult";
import { toVec3 } from "../runtime/PositionAdapter";
import { errorMessage } from "../shared/helper";
import { PositionSchema, type Position } from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

export interface GotoInput {
  position: Position;
  range?: number;
}

export interface GotoOutput {
  position: Position;
  distanceToTarget: number;
}

export class GotoCapability implements Capability<GotoInput, GotoOutput> {
  readonly name = "goto";
  readonly inputSchema: z.ZodType<GotoInput> = z
    .object({
      position: PositionSchema,
      range: z.number().finite().nonnegative().max(64).optional(),
    })
    .strict();

  async execute(
    input: GotoInput,
    context: ExecutionContext,
  ): Promise<TaskResult<GotoOutput>> {
    const bot = context.runtime.bot;
    const target = toVec3(input.position);
    const stopPathfinder = (): void => bot.pathfinder.stop();

    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", stopPathfinder, { once: true });

    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(
          input.position.x,
          input.position.y,
          input.position.z,
          input.range ?? 1,
        ),
      );
      context.signal.throwIfAborted();

      return success({
        position: {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        },
        distanceToTarget: bot.entity.position.distanceTo(target),
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;

      const errorCode = expectedPathfinderErrorCode(error);
      if (!errorCode) throw error;

      return failure(
        errorCode,
        `Could not reach (${input.position.x}, ${input.position.y}, ${input.position.z}): ${errorMessage(error)}`,
        {
          retryable: true,
          facts: {
            target: input.position,
            range: input.range ?? 1,
          },
        },
      );
    } finally {
      context.signal.removeEventListener("abort", stopPathfinder);
    }
  }
}

function expectedPathfinderErrorCode(error: unknown): TaskErrorCode | null {
  if (!(error instanceof Error)) return null;

  switch (error.name) {
    case "NoPath":
    case "Timeout":
      return "NO_PATH";
    case "GoalChanged":
      return "WORLD_CHANGED";
    case "PathStopped":
      return "BLOCKED";
    default:
      return null;
  }
}
