import type { Chest } from "mineflayer";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { ContainerSessionManager } from "../runtime/ContainerSessionManager";
import { errorMessage, normalizeMinecraftName } from "../shared/helper";
import type { Capability, ExecutionContext } from "./Capability";

export interface TransferItemInput {
  sessionId: string;
  direction: "deposit" | "withdraw";
  item: string;
  quantity: number;
}

export interface TransferItemOutput {
  sessionId: string;
  direction: TransferItemInput["direction"];
  item: string;
  quantity: number;
  inventoryBefore: number;
  inventoryAfter: number;
  containerBefore: number;
  containerAfter: number;
}

export class TransferItemCapability
  implements Capability<TransferItemInput, TransferItemOutput>
{
  readonly name = "transfer_item";
  readonly inputSchema: z.ZodType<TransferItemInput> = z
    .object({
      sessionId: z.string().uuid().describe("Opaque sessionId returned by open_container. Do not invent an ID."),
      direction: z.enum(["deposit", "withdraw"]).describe("deposit: bot to container; withdraw: container to bot."),
      item: z.string().trim().min(1).describe('Exact item ID, e.g. "oak_log".'),
      quantity: z.number().int().positive().describe("Exact positive item quantity to transfer, not a number of stacks."),
    })
    .strict();

  constructor(private readonly sessions: ContainerSessionManager) {}

  async execute(
    input: TransferItemInput,
    context: ExecutionContext,
  ): Promise<TaskResult<TransferItemOutput>> {
    const resolved = this.sessions.resolve(input.sessionId);
    if (!resolved.ok) {
      return failure(
        resolved.reason === "mismatch"
          ? "WORLD_CHANGED"
          : "CONTAINER_NOT_OPEN",
        `Container session "${input.sessionId}" is ${resolved.reason}.`,
        { retryable: false, facts: { sessionId: input.sessionId } },
      );
    }

    const bot = context.runtime.bot;
    const itemName = normalizeMinecraftName(input.item);
    const itemData = bot.registry.itemsByName[itemName];
    if (!itemData) {
      return failure("MISSING_ITEM", `Unknown item "${input.item}".`, {
        facts: { item: input.item },
      });
    }

    const window = resolved.window as Chest;
    const inventoryBefore = window.count(itemData.id, null);
    const containerBefore = window.containerCount(itemData.id, null);
    if (
      (input.direction === "deposit" &&
        inventoryBefore < input.quantity) ||
      (input.direction === "withdraw" &&
        containerBefore < input.quantity)
    ) {
      return failure(
        "MISSING_ITEM",
        `Not enough "${itemName}" for ${input.direction}.`,
        {
          facts: {
            item: itemName,
            requested: input.quantity,
            available:
              input.direction === "deposit"
                ? inventoryBefore
                : containerBefore,
          },
        },
      );
    }

    const closeOnAbort = (): void => {
      void this.sessions.closeActive("transfer_item interrupted");
    };
    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", closeOnAbort, { once: true });

    try {
      if (input.direction === "deposit") {
        await window.deposit(itemData.id, null, input.quantity);
      } else {
        await window.withdraw(itemData.id, null, input.quantity);
      }
      context.signal.throwIfAborted();

      const inventoryAfter = window.count(itemData.id, null);
      const containerAfter = window.containerCount(itemData.id, null);
      const inventoryDelta = inventoryAfter - inventoryBefore;
      const containerDelta = containerAfter - containerBefore;
      const confirmed =
        input.direction === "deposit"
          ? inventoryDelta === -input.quantity &&
            containerDelta === input.quantity
          : inventoryDelta === input.quantity &&
            containerDelta === -input.quantity;
      if (!confirmed) {
        return failure(
          "ACTION_NOT_CONFIRMED",
          `Transfer of "${itemName}" was not reflected by the window.`,
          {
            retryable: true,
            facts: {
              inventoryBefore,
              inventoryAfter,
              containerBefore,
              containerAfter,
            },
          },
        );
      }

      return success({
        sessionId: input.sessionId,
        direction: input.direction,
        item: itemName,
        quantity: input.quantity,
        inventoryBefore,
        inventoryAfter,
        containerBefore,
        containerAfter,
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;
      const message = errorMessage(error);
      if (
        message.includes("Can't find") ||
        message.includes("destination full") ||
        message.includes("inventory is full") ||
        message.includes("transaction")
      ) {
        return failure("BLOCKED", message, { retryable: true });
      }
      throw error;
    } finally {
      context.signal.removeEventListener("abort", closeOnAbort);
    }
  }
}
