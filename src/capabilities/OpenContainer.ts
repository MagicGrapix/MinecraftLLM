import type { Item } from "prismarine-item";
import type { Window } from "prismarine-windows";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import {
  ContainerSessionManager,
  type ContainerSession,
} from "../runtime/ContainerSessionManager";
import { toVec3 } from "../runtime/PositionAdapter";
import { BlockPositionSchema, type Position } from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

export interface OpenContainerInput {
  position: Position;
  expectedBlock?: string;
}

export interface ContainerSlotSnapshot {
  slot: number;
  item: string;
  count: number;
  metadata: number;
}

export interface OpenContainerOutput extends ContainerSession {
  slots: readonly ContainerSlotSnapshot[];
}

export class OpenContainerCapability
  implements Capability<OpenContainerInput, OpenContainerOutput>
{
  readonly name = "open_container";
  readonly inputSchema: z.ZodType<OpenContainerInput> = z
    .object({
      position: BlockPositionSchema,
      expectedBlock: z.string().trim().min(1).optional(),
    })
    .strict();

  constructor(private readonly sessions: ContainerSessionManager) {}

  async execute(
    input: OpenContainerInput,
    context: ExecutionContext,
  ): Promise<TaskResult<OpenContainerOutput>> {
    const bot = context.runtime.bot;
    if (this.sessions.snapshot() || bot.currentWindow) {
      return failure("BLOCKED", "A container session is already active.", {
        retryable: true,
        facts: { session: this.sessions.snapshot() },
      });
    }

    const block = bot.blockAt(toVec3(input.position));
    if (!block || block.boundingBox === "empty") {
      return failure("TARGET_NOT_FOUND", "The container block does not exist.", {
        facts: { position: input.position },
      });
    }
    if (input.expectedBlock && block.name !== input.expectedBlock) {
      return failure(
        "WORLD_CHANGED",
        `Expected "${input.expectedBlock}" but found "${block.name}".`,
        { retryable: true, facts: { position: input.position } },
      );
    }
    if (!isSupportedContainer(block.name)) {
      return failure(
        "BLOCKED",
        `Block "${block.name}" is not a supported generic container.`,
        {
          facts: {
            block: block.name,
            specializedCapability: isFurnace(block.name)
              ? "open_furnace"
              : null,
          },
        },
      );
    }
    if (
      bot.entity.position.distanceTo(block.position) > 4.5 ||
      !bot.canSeeBlock(block)
    ) {
      return failure("OUT_OF_REACH", "The container is out of reach.", {
        retryable: true,
        facts: { position: input.position },
      });
    }

    context.signal.throwIfAborted();
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    const raycastBlock = bot.blockAtCursor(5);
    if (!raycastBlock || !raycastBlock.position.equals(block.position)) {
      return failure(
        "OUT_OF_REACH",
        "Raycast does not point at the requested container.",
        { retryable: true, facts: { position: input.position } },
      );
    }

    const closeOnAbort = (): void => {
      const window = bot.currentWindow;
      if (window) void bot.closeWindow(window);
      void this.sessions.closeActive("open_container interrupted");
    };
    context.signal.addEventListener("abort", closeOnAbort, { once: true });

    try {
      const window = await bot.openContainer(block);
      if (context.signal.aborted) {
        await bot.closeWindow(window);
      }
      context.signal.throwIfAborted();
      const session = this.sessions.create(window, input.position);
      return success({
        ...session,
        slots: window.containerItems().map(toSlotSnapshot),
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("container") ||
        message.includes("window") ||
        message.includes("open")
      ) {
        return failure("BLOCKED", message, { retryable: true });
      }
      throw error;
    } finally {
      context.signal.removeEventListener("abort", closeOnAbort);
    }
  }
}

function isSupportedContainer(name: string): boolean {
  return (
    name === "chest" ||
    name === "trapped_chest" ||
    name === "ender_chest" ||
    name === "barrel" ||
    name === "hopper" ||
    name === "dispenser" ||
    name === "dropper" ||
    name.endsWith("_shulker_box")
  );
}

function isFurnace(name: string): boolean {
  return (
    name === "furnace" ||
    name === "blast_furnace" ||
    name === "smoker"
  );
}

function toSlotSnapshot(item: Item): ContainerSlotSnapshot {
  return {
    slot: item.slot,
    item: item.name,
    count: item.count,
    metadata: item.metadata,
  };
}
