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
import { GotoPathDiagnostics } from "./GotoPathDiagnostics";
import { navigateToGoal } from "./GotoNavigation";

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
    const range = input.range ?? 1;
    const goal = new goals.GoalNear(
      input.position.x,
      input.position.y,
      input.position.z,
      range,
    );
    const stopPathfinder = (): void => bot.pathfinder.stop();

    context.signal.throwIfAborted();
    const diagnostics = new GotoPathDiagnostics(
      bot,
      context.world,
      input.position,
      range,
    );
    context.signal.addEventListener("abort", stopPathfinder, { once: true });

    try {
      await navigateToGoal(bot, goal);
      context.signal.throwIfAborted();

      // Some pathfinder versions resolve goto on an empty path_update even
      // when the goal has not been reached. Do not report that as success.
      if (!isWithinGoal(bot.entity.position, input.position, range)) {
        return pathFailure(
          "NO_PATH",
          "Pathfinder stopped before reaching the goal.",
          diagnostics,
        );
      }

      return success({
        position: {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        },
        distanceToTarget: bot.entity.position.distanceTo(target),
      });
    } catch (error: unknown) {
      if (context.signal.aborted) {
        console.warn(
          "Goto interrupted while pathfinder was searching.",
          diagnostics.failureFacts("interrupted"),
        );
        throw error;
      }

      const errorCode = expectedPathfinderErrorCode(error);
      if (!errorCode) throw error;

      return pathFailure(
        errorCode,
        `Could not reach (${input.position.x}, ${input.position.y}, ${input.position.z}): ${errorMessage(error)}`,
        diagnostics,
        error instanceof Error ? error.name : "unknown",
      );
    } finally {
      context.signal.removeEventListener("abort", stopPathfinder);
      diagnostics.detach();
    }
  }
}

function isWithinGoal(
  position: Position,
  target: Position,
  range: number,
): boolean {
  const dx = Math.floor(position.x) - Math.floor(target.x);
  const dy = Math.floor(position.y) - Math.floor(target.y);
  const dz = Math.floor(position.z) - Math.floor(target.z);
  return dx * dx + dy * dy + dz * dz <= range * range;
}

function pathFailure(
  code: TaskErrorCode,
  message: string,
  diagnostics: GotoPathDiagnostics,
  reason = "goal_not_reached",
): TaskResult<GotoOutput> {
  const facts = diagnostics.failureFacts(reason);
  console.warn("Goto pathfinder failed.", { code, message, facts });
  return failure(code, message, { retryable: true, facts });
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
