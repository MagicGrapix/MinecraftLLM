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
import { navigateToGoal, waitForNavigationLanding } from "./GotoNavigation";
import { createGotoMovements, gotoMovementFacts } from "./GotoMovements";
import { GotoTerrainTracker, type ObservedBlockChange } from "./GotoTerrainTracker";
import { NavigationOperations } from "../runtime/NavigationOperations";

export interface GotoInput {
  position: Position;
  range?: number;
  goal?: "near" | "interact";
  canDig?: boolean;
  canPlace?: boolean;
}

export interface GotoOutput {
  position: Position;
  distanceToTarget: number;
  goal: "near" | "interact";
  observedBlockChanges: ObservedBlockChange[];
  movements: ReturnType<typeof gotoMovementFacts>;
}

export class GotoCapability implements Capability<GotoInput, GotoOutput> {
  readonly name = "goto";
  readonly inputSchema: z.ZodType<GotoInput> = z
    .object({
      position: PositionSchema,
      range: z.number().finite().nonnegative().max(64).optional()
        .describe("Near goal radius (default 1); interact reach (default 4.5, maximum 4.5)."),
      goal: z.enum(["near", "interact"]).optional()
        .describe("near: move to a feet-level position. interact: approach a visible block face within reach; does not dig the target."),
      canDig: z.boolean().optional().describe("Allow breaking route obstacles (default true). The target block and workstations are protected."),
      canPlace: z.boolean().optional().describe("Allow bridges/towers using dirt or cobblestone already in inventory (default true). Does not acquire or give materials."),
    })
    .strict()
    .refine((input) => input.goal !== "interact" || input.range === undefined || (input.range > 0 && input.range <= 4.5),
      { message: "interact reach must be greater than 0 and at most 4.5.", path: ["range"] });

  async execute(
    input: GotoInput,
    context: ExecutionContext,
  ): Promise<TaskResult<GotoOutput>> {
    const bot = context.runtime.bot;
    const target = toVec3(input.position);
    const goalKind = input.goal ?? "near";
    const range = input.range ?? (goalKind === "interact" ? 4.5 : 1);
    const targetBlock = goalKind === "interact" ? bot.blockAt(target.floored()) : null;
    if (goalKind === "interact" && (!targetBlock || targetBlock.boundingBox === "empty")) {
      return failure("TARGET_NOT_FOUND", "The interaction target must be a loaded, non-empty block.", { facts: { position: input.position } });
    }
    const goal = goalKind === "interact"
      ? new goals.GoalLookAtBlock(target.floored(), bot.world, { reach: range })
      : new goals.GoalNear(
          input.position.x,
          input.position.y,
          input.position.z,
          range,
        );

    context.signal.throwIfAborted();
    const previousMovements = bot.pathfinder.movements;
    const movements = createGotoMovements(bot, input.position, input);
    bot.pathfinder.setMovements(movements);
    const terrain = new GotoTerrainTracker(bot);
    const diagnostics = new GotoPathDiagnostics(
      bot,
      context.world,
      input.position,
      range,
    );
    const movementFacts = () => ({
      goal: goalKind,
      movements: gotoMovementFacts(bot, movements),
      observedBlockChanges: terrain.snapshot(),
    });

    const operations = new NavigationOperations(bot, context.signal, context.deferCancellationUntil);
    try {
      let arrived = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const navigation = navigateToGoal(bot, goal, context.signal);
        context.deferCancellationUntil(navigation);
        await navigation;
        await waitForNavigationLanding(bot, context.signal);
        context.signal.throwIfAborted();
        const feet = bot.entity.position.floored();
        const atPartialHeight = Math.abs(bot.entity.position.y - Math.round(bot.entity.position.y)) > 0.001;
        arrived = goal.isEnd(feet as unknown as Parameters<typeof goal.isEnd>[0]) ||
          (atPartialHeight && goal.isEnd(feet.offset(0, 1, 0) as unknown as Parameters<typeof goal.isEnd>[0]));
        if (arrived) break;
        // A tower jump may cross the goal before its support block is placed.
        // Recompute from the landed position instead of accepting that jump.
      }
      if (targetBlock) {
        const current = bot.blockAt(target.floored());
        if (!current || current.stateId !== targetBlock.stateId) {
          return failure("WORLD_CHANGED", "The interaction target changed during navigation.", {
            retryable: true, facts: { position: input.position, expectedBlock: targetBlock.name, ...movementFacts() },
          });
        }
      }

      // Check the actual goal after landing, not just the arrival event.
      if (!arrived) {
        return pathFailure(
          "BLOCKED",
          "Pathfinder signaled arrival, but the bot did not remain at the goal after landing.",
          diagnostics,
          movementFacts(),
          "arrival_not_stable",
        );
      }

      return success({
        position: {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        },
        distanceToTarget: bot.entity.position.distanceTo(target),
        goal: goalKind,
        observedBlockChanges: terrain.snapshot(),
        movements: gotoMovementFacts(bot, movements),
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
        movementFacts(),
        error instanceof Error ? error.name : "unknown",
      );
    } finally {
      try { await operations.finish(); }
      finally {
        diagnostics.detach();
        terrain.detach();
        bot.pathfinder.setMovements(previousMovements);
      }
    }
  }
}

function pathFailure(
  code: TaskErrorCode,
  message: string,
  diagnostics: GotoPathDiagnostics,
  movementFacts: Record<string, unknown>,
  reason = "goal_not_reached",
): TaskResult<GotoOutput> {
  const facts = { ...diagnostics.failureFacts(reason), ...movementFacts };
  console.warn("Goto pathfinder failed.", { code, message, facts });
  return failure(code, message, { retryable: code !== "NO_PATH" && reason !== "arrival_not_stable", facts });
}

function expectedPathfinderErrorCode(error: unknown): TaskErrorCode | null {
  if (!(error instanceof Error)) return null;

  switch (error.name) {
    case "NoPath":
      return "NO_PATH";
    case "Timeout":
      return "TIMEOUT";
    case "GoalChanged":
      return "WORLD_CHANGED";
    case "PathStopped":
      return "BLOCKED";
    case "ConnectionEnded":
      return "WORLD_CHANGED";
    default:
      return null;
  }
}
