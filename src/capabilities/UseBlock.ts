import type { Window } from "prismarine-windows";
import { Vec3 } from "vec3";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { toVec3 } from "../runtime/PositionAdapter";
import {
  BlockFaceSchema,
  BlockPositionSchema,
  CursorPositionSchema,
  type BlockFace,
  type CursorPosition,
  type Position,
} from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

export interface UseBlockInput {
  position: Position;
  expectedBlock?: string;
  face?: BlockFace;
  cursor?: CursorPosition;
  hand: "hand";
}

export interface UseBlockOutput {
  position: Position;
  block: string;
  stateIdBefore: number;
  stateIdAfter: number;
  confirmed: true;
}

const faceVectors: Record<BlockFace, Vec3> = {
  top: new Vec3(0, 1, 0),
  bottom: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
};

export class UseBlockCapability
  implements Capability<UseBlockInput, UseBlockOutput>
{
  readonly name = "use_block";
  readonly inputSchema: z.ZodType<UseBlockInput> = z
    .object({
      position: BlockPositionSchema,
      expectedBlock: z.string().trim().min(1).optional(),
      face: BlockFaceSchema.optional(),
      cursor: CursorPositionSchema.optional(),
      hand: z.literal("hand"),
    })
    .strict();

  async execute(
    input: UseBlockInput,
    context: ExecutionContext,
  ): Promise<TaskResult<UseBlockOutput>> {
    const bot = context.runtime.bot;
    const target = toVec3(input.position);
    const block = bot.blockAt(target);

    if (!block || block.boundingBox === "empty") {
      return failure("TARGET_NOT_FOUND", "The target block does not exist.", {
        facts: { position: input.position },
      });
    }
    if (input.expectedBlock && block.name !== input.expectedBlock) {
      return failure(
        "WORLD_CHANGED",
        `Expected "${input.expectedBlock}" but found "${block.name}".`,
        {
          retryable: true,
          facts: {
            position: input.position,
            expectedBlock: input.expectedBlock,
            actualBlock: block.name,
          },
        },
      );
    }
    if (!isSimpleInteractiveBlock(block.name)) {
      return failure(
        "BLOCKED",
        `Block "${block.name}" is not supported by use_block.`,
        {
          facts: {
            block: block.name,
            requiredCapability: requiredCapability(block.name),
          },
        },
      );
    }
    if (
      bot.entity.position.distanceTo(block.position) > 4.5 ||
      !bot.canSeeBlock(block)
    ) {
      return failure("OUT_OF_REACH", `Block "${block.name}" is out of reach.`, {
        retryable: true,
        facts: { position: input.position, block: block.name },
      });
    }
    if (bot.currentWindow) {
      return failure("BLOCKED", "A window is already open.", {
        retryable: true,
      });
    }

    let openedWindow: Window | null = null;
    const rejectWindow = (window: Window): void => {
      openedWindow = window;
      void bot.closeWindow(window);
    };
    bot.on("windowOpen", rejectWindow);

    try {
      context.signal.throwIfAborted();
      const cursor = input.cursor ?? { x: 0.5, y: 0.5, z: 0.5 };
      await bot.lookAt(block.position.offset(cursor.x, cursor.y, cursor.z), true);
      context.signal.throwIfAborted();

      const raycastBlock = bot.blockAtCursor(5);
      if (!raycastBlock || !raycastBlock.position.equals(block.position)) {
        return failure(
          "OUT_OF_REACH",
          "Raycast does not point at the requested block.",
          { retryable: true, facts: { position: input.position } },
        );
      }

      await bot.activateBlock(
        block,
        faceVectors[input.face ?? "top"],
        new Vec3(cursor.x, cursor.y, cursor.z),
      );
      context.signal.throwIfAborted();
      await bot.waitForTicks(2);
      context.signal.throwIfAborted();

      if (openedWindow) {
        return failure(
          "BLOCKED",
          `Block "${block.name}" opened a window and was closed.`,
          {
            facts: {
              block: block.name,
              requiredCapability: requiredCapability(block.name),
            },
          },
        );
      }

      const blockAfter = bot.blockAt(target);
      if (!blockAfter || blockAfter.name !== block.name) {
        return failure(
          "WORLD_CHANGED",
          `Block "${block.name}" changed identity during interaction.`,
          { retryable: true, facts: { position: input.position } },
        );
      }
      if (blockAfter.stateId === block.stateId) {
        return failure(
          "ACTION_NOT_CONFIRMED",
          `No state change was observed for "${block.name}".`,
          {
            retryable: true,
            facts: { position: input.position, stateId: block.stateId },
          },
        );
      }

      return success({
        position: input.position,
        block: block.name,
        stateIdBefore: block.stateId,
        stateIdAfter: blockAfter.stateId,
        confirmed: true,
      });
    } finally {
      bot.removeListener("windowOpen", rejectWindow);
    }
  }
}

function isSimpleInteractiveBlock(name: string): boolean {
  return (
    name === "lever" ||
    name.endsWith("_button") ||
    name.endsWith("_door") ||
    name.endsWith("_trapdoor") ||
    name.endsWith("_fence_gate")
  );
}

function requiredCapability(blockName: string): string {
  if (blockName === "crafting_table") return "craft_from_table_3x3";
  if (
    blockName.includes("chest") ||
    blockName === "barrel" ||
    blockName.includes("shulker")
  ) {
    return "get_chest_contents or use_chest (single ordinary chest only)";
  }
  if (
    blockName.includes("furnace") ||
    blockName === "smoker" ||
    blockName === "blast_furnace"
  ) {
    return "get_furnace_contents or use_furnace (standard furnace only)";
  }
  return "unsupported";
}
