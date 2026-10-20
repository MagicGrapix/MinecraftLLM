import { z } from "zod";
import type { Capability, ExecutionContext } from "./Capability";
import { failure, success } from "../execution/TaskResult";
import { normalizeMinecraftName } from "../shared/helper";
import { withStation, stationInventory, type StationResult } from "../runtime/StationInteraction";
import { windowCapacity, windowTotals } from "../runtime/ServerWindowObservation";
import { ACTION_CONFIRMATION } from "../config";
import type { ConfirmationTiming } from "../runtime/waitForConfirmation";

export class GetChestContentsCapability implements Capability<Record<string, never>, StationResult> {
  readonly name = "get_chest_contents";
  readonly inputSchema = z.object({}).strict();
  constructor(private readonly timing: ConfirmationTiming = ACTION_CONFIRMATION) {}
  execute(_input: Record<string, never>, context: ExecutionContext) {
    return withStation("chest", context, async session => {
      const totals = windowTotals(session.snapshot().slots.slice(0, session.window.inventoryStart));
      return success({ items: Object.entries(totals).sort().map(([item, count]) => ({ item, count })) });
    }, this.timing);
  }
}

export interface UseChestInput { direction: "deposit" | "withdraw"; item: string; quantity: number }
export class UseChestCapability implements Capability<UseChestInput, StationResult> {
  readonly name = "use_chest";
  readonly inputSchema = z.object({
    direction: z.enum(["deposit", "withdraw"]).describe("deposit: bot inventory to chest; withdraw: chest to bot inventory."),
    item: z.string().trim().min(1).describe('Exact ordinary item ID, e.g. "oak_log".'),
    quantity: z.number().int().safe().positive().describe("Exact number of items to transfer, not a final stock or number of stacks."),
  }).strict();
  constructor(private readonly timing: ConfirmationTiming = ACTION_CONFIRMATION) {}
  execute(input: UseChestInput, context: ExecutionContext) {
    const item = normalizeMinecraftName(input.item), data = context.runtime.bot.registry.itemsByName[item];
    if (!data) return Promise.resolve(failure("INVALID_ARGUMENT", `Unknown item "${input.item}". Use an exact Minecraft item name.`));
    return withStation("chest", context, async session => {
      const { window, bot } = session;
      const initial = session.snapshot();
      const inventoryBefore = stationInventory(session, initial)[item] ?? 0;
      const chestBefore = windowTotals(initial.slots.slice(0, window.inventoryStart))[item] ?? 0;
      const deposit = input.direction === "deposit", available = deposit ? inventoryBefore : chestBefore;
      const destination = deposit ? initial.slots.slice(0, window.inventoryStart) : initial.slots.slice(window.inventoryStart, window.inventoryEnd);
      if (available < input.quantity) return failure("MISSING_ITEM", `Not enough ${item} in ${deposit ? "bot inventory" : "chest"}.`,
        { facts: { requested: input.quantity, available } });
      if (windowCapacity(destination, item, data.stackSize) < input.quantity) return failure("BLOCKED",
        `Not enough room in ${deposit ? "chest" : "bot inventory"} for ${input.quantity} ${item}.`);
      session.progress({ item, direction: input.direction, requested: input.quantity, transferred: null, inventoryBefore, chestBefore });
      // Use the same native transfer primitive as deposit/withdraw; withdraw's empty-slot shortcut
      // incorrectly rejects a full inventory that has room in an existing compatible stack.
      const state = await session.attempt(input.direction, () => bot.transfer({
        window, itemType: data.id, metadata: null, count: input.quantity,
        sourceStart: deposit ? window.inventoryStart : 0,
        sourceEnd: deposit ? window.inventoryEnd : window.inventoryStart,
        destStart: deposit ? 0 : window.inventoryStart,
        destEnd: deposit ? window.inventoryStart : window.inventoryEnd,
      }));
      const inventoryAfter = stationInventory(session, state)[item] ?? 0;
      const chestAfter = windowTotals(state.slots.slice(0, window.inventoryStart))[item] ?? 0;
      const inventoryDelta = (inventoryAfter - inventoryBefore) * (deposit ? -1 : 1);
      const chestDelta = (chestAfter - chestBefore) * (deposit ? 1 : -1);
      const transferred = inventoryDelta === chestDelta && inventoryDelta >= 0 ? Math.max(0, inventoryDelta) : null;
      const report = { item, direction: input.direction, requested: input.quantity, transferred,
        inventoryBefore, inventoryAfter, chestBefore, chestAfter };
      session.progress(report);
      if (transferred !== input.quantity || state.cursor !== null) return failure("ACTION_NOT_CONFIRMED",
        "The exact chest transfer was not confirmed. Read the chest and bot inventory before requesting any remainder.");
      session.expectInventory({ [item]: inventoryAfter });
      return success(report);
    }, this.timing);
  }
}
