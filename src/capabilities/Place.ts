import { Vec3 } from "vec3";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { fromVec3, toVec3 } from "../runtime/PositionAdapter";
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

    if (targetBlock && targetBlock.boundingBox !== "empty") {
      return failure("BLOCKED", "The placement target is already occupied.", {
        retryable: true,
        facts: { position: fromVec3(targetPosition) },
      });
    }

    context.signal.throwIfAborted();

    try {
      await bot.placeBlock(referenceBlock, faceVector);
      context.signal.throwIfAborted();

      return success({
        item: heldItem.name,
        position: fromVec3(targetPosition),
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;

      return failure(
        "WORLD_CHANGED",
        `Could not place "${heldItem.name}": ${errorMessage(error)}`,
        {
          retryable: true,
          facts: {
            referencePosition: input.referencePosition,
            face: input.face,
          },
        },
      );
    }
  }
}
