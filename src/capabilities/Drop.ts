import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { errorMessage, normalizeMinecraftName } from "../shared/helper";
import type { Capability, ExecutionContext } from "./Capability";

export type DropInput =
  | { mode: "all" }
  | { mode: "item"; item: string; count?: number };

export interface DropOutput {
  dropped: Record<string, number>;
}

const dropInputSchema: z.ZodType<DropInput> = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("item"),
      item: z.string().trim().min(1).describe('Exact inventory item ID, e.g. "dirt".'),
      count: z.number().int().positive().optional().describe("Number of items to drop; omit to drop all stacks of this item."),
    })
    .strict(),
]).describe('Example: {"mode":"item","item":"dirt","count":2}. {"mode":"all"} drops the entire inventory.');

export class DropCapability implements Capability<DropInput, DropOutput> {
  readonly name = "drop";
  readonly inputSchema = dropInputSchema;

  async execute(
    input: DropInput,
    context: ExecutionContext,
  ): Promise<TaskResult<DropOutput>> {
    const bot = context.runtime.bot;
    const dropped: Record<string, number> = {};

    try {
      if (input.mode === "all") {
        for (const item of bot.inventory.items()) {
          context.signal.throwIfAborted();
          await bot.tossStack(item);
          dropped[item.name] = (dropped[item.name] ?? 0) + item.count;
        }

        return success({ dropped });
      }

      const itemName = normalizeMinecraftName(input.item);
      const matchingItems = bot.inventory
        .items()
        .filter((item) => item.name === itemName);
      const available = matchingItems.reduce((total, item) => total + item.count, 0);

      if (available === 0 || (input.count !== undefined && input.count > available)) {
        return failure(
          "MISSING_ITEM",
          `Cannot drop ${input.count ?? "any"} "${input.item}"; ${available} available.`,
          {
            retryable: false,
            facts: {
              item: input.item,
              requested: input.count ?? available,
              available,
            },
          },
        );
      }

      context.signal.throwIfAborted();

      if (input.count !== undefined) {
        const firstItem = matchingItems[0];
        if (!firstItem) {
          return failure("MISSING_ITEM", `Item "${input.item}" is unavailable.`);
        }

        await bot.toss(firstItem.type, firstItem.metadata, input.count);
        dropped[itemName] = input.count;
      } else {
        for (const item of matchingItems) {
          context.signal.throwIfAborted();
          await bot.tossStack(item);
          dropped[itemName] = (dropped[itemName] ?? 0) + item.count;
        }
      }

      context.signal.throwIfAborted();
      return success({ dropped });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;

      return failure("BLOCKED", `Could not drop inventory items: ${errorMessage(error)}`, {
        retryable: true,
        facts: { dropped },
      });
    }
  }
}
