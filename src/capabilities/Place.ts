import { Vec3 } from "vec3";
import { z } from "zod";
import { ACTION_CONFIRMATION } from "../config";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { fromVec3, toVec3 } from "../runtime/PositionAdapter";
import { ServerBlockObservation } from "../runtime/ServerBlockObservation";
import { waitForConfirmation, type ConfirmationTiming } from "../runtime/waitForConfirmation";
import { writeTrace } from "../TraceLog";
import { errorMessage } from "../shared/helper";
import {
  BlockFaceSchema,
  BlockPositionSchema,
  type BlockFace,
  type Position,
} from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

export interface PlaceInput {
  referencePosition: Position;
  face: BlockFace;
}

export interface PlaceOutput {
  item: string;
  position: Position;
}

const faceVectors: Record<BlockFace, Vec3> = {
  top: new Vec3(0, 1, 0),
  bottom: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
};

export class PlaceCapability implements Capability<PlaceInput, PlaceOutput> {
  readonly name = "place";
  constructor(private readonly timing: ConfirmationTiming = ACTION_CONFIRMATION) {}
  readonly inputSchema: z.ZodType<PlaceInput> = z
    .object({
      referencePosition: BlockPositionSchema.describe(`${BlockPositionSchema.description} This is the existing support block, NOT the destination cell.`),
      face: BlockFaceSchema.describe("Face of the support block to place against: top=+Y, bottom=-Y, north=-Z, south=+Z, east=+X, west=-X."),
    })
    .strict();

  async execute(
    input: PlaceInput,
    context: ExecutionContext,
  ): Promise<TaskResult<PlaceOutput>> {
    const bot = context.runtime.bot;
    const heldItem = bot.heldItem;

    if (!heldItem) {
      return failure("MISSING_ITEM", "No block is equipped in the bot's hand.", {
        retryable: false,
      });
    }

    // This capability places blocks, not items that transform into a different block (seeds, redstone...).
    const expected = bot.registry.blocksByName[heldItem.name]?.name;
    if (!expected) return failure("INVALID_ARGUMENT", "The held item has no matching block to confirm.", {
      facts: { item: heldItem.name },
    });

    const referenceBlock = bot.blockAt(toVec3(input.referencePosition));
    if (!referenceBlock || referenceBlock.boundingBox === "empty") {
      return failure(
        "TARGET_NOT_FOUND",
        "The reference block used for placement does not exist.",
        {
          retryable: false,
          facts: { referencePosition: input.referencePosition },
        },
      );
    }

    const faceVector = faceVectors[input.face];
    const targetPosition = referenceBlock.position.plus(faceVector);
    const targetBlock = bot.blockAt(targetPosition);

    if (!targetBlock) return failure("WORLD_CHANGED", "The placement target is not loaded.", {
      facts: { position: fromVec3(targetPosition), verification: "unknown" },
    });
    if (targetBlock.boundingBox !== "empty") {
      return failure("BLOCKED", "The placement target is already occupied.", {
        retryable: true,
        facts: { position: fromVec3(targetPosition) },
      });
    }

    context.signal.throwIfAborted();
    const observation = new ServerBlockObservation(bot, targetPosition);
    const unavailable = new AbortController();
    const onUnavailable = () => unavailable.abort(new Error("Connection or player state changed during placement."));
    for (const event of ["end", "death", "respawn"] as const) bot.on(event, onUnavailable);
    const signal = AbortSignal.any([context.signal, unavailable.signal]);
    const started = performance.now();
    const position = fromVec3(targetPosition);
    let cause: string | undefined;
    const snapshot = () => {
      const block = bot.blockAt(targetPosition);
      return { observed: block?.name ?? null, observedStateId: block?.stateId ?? null, serverStateId: observation.stateId };
    };
    const trace = (stage: string, extra = {}) => writeTrace("place.confirmation", {
      taskId: context.taskId, position, expected, stage, elapsedMs: Math.round(performance.now() - started),
      cause, ...snapshot(), ...extra,
    });
    try {
      trace("attempt");
      try {
        const operation = bot.placeBlock(referenceBlock, faceVector);
        context.deferCancellationUntil(operation);
        // Even an early server confirmation cannot release the physical lock before Mineflayer settles.
        await operation;
      } catch (error) {
        cause = errorMessage(error);
      }
      signal.throwIfAborted();
      trace("settled");
      let lastObservation = "";
      const confirmed = await waitForConfirmation(() => {
        const current = JSON.stringify(snapshot());
        if (current !== lastObservation) { lastObservation = current; trace("observed"); }
        return observation.matches(block => block.name === expected);
      }, signal, this.timing);
      signal.throwIfAborted();
      trace(confirmed ? "confirmed" : "expired");
      if (!confirmed) {
        const state = snapshot();
        return failure("ACTION_NOT_CONFIRMED", "The server did not confirm the expected block. Inspect the target before retrying; it may still change.", {
          retryable: true,
          facts: { position, expected, ...state, confirmationTimeoutMs: this.timing.timeoutMs,
            verification: state.observed === null ? "unknown" : state.serverStateId === null || state.serverStateId !== state.observedStateId ? "unconfirmed" : "mismatch",
            ...(cause ? { cause } : {}) },
        });
      }
      return success({
        item: heldItem.name,
        position,
      });
    } catch (error: unknown) {
      trace("interrupted", { reason: errorMessage(error) });
      context.signal.throwIfAborted();
      if (!unavailable.signal.aborted) throw error;
      return failure("WORLD_CHANGED", errorMessage(unavailable.signal.reason), {
        facts: { position, expected, verification: "unknown", ...(cause ? { cause } : {}) },
      });
    } finally {
      observation.dispose();
      for (const event of ["end", "death", "respawn"] as const) bot.removeListener(event, onUnavailable);
    }
  }
}
