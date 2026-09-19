import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { errorMessage, normalizeMinecraftName } from "../shared/helper";
import {
  EquipmentDestinationSchema,
  type EquipmentDestination,
} from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

export interface EquipInput {
  item: string;
  destination?: EquipmentDestination;
}

export interface EquipOutput {
  item: string;
  slot: number;
  destination: EquipmentDestination;
}

export class EquipCapability implements Capability<EquipInput, EquipOutput> {
  readonly name = "equip";
  readonly inputSchema: z.ZodType<EquipInput> = z
    .object({
      item: z.string().trim().min(1),
      destination: EquipmentDestinationSchema.optional(),
    })
    .strict();

  async execute(
    input: EquipInput,
    context: ExecutionContext,
  ): Promise<TaskResult<EquipOutput>> {
    const bot = context.runtime.bot;
    const itemName = normalizeMinecraftName(input.item);
    const item = bot.inventory.items().find((candidate) => candidate.name === itemName);

    if (!item) {
      return failure(
        "MISSING_ITEM",
        `Item "${input.item}" is not present in the inventory.`,
        { retryable: false, facts: { item: input.item } },
      );
    }

    const destination = input.destination ?? "hand";
    context.signal.throwIfAborted();

    try {
      await bot.equip(item, destination);
      context.signal.throwIfAborted();

      return success({
        item: item.name,
        slot: item.slot,
        destination,
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;

      return failure(
        "BLOCKED",
        `Could not equip "${input.item}": ${errorMessage(error)}`,
        { retryable: true, facts: { item: input.item, destination } },
      );
    }
  }
}
