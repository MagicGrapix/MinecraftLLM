import type { Furnace } from "mineflayer";
import { z } from "zod";
import type { Capability, ExecutionContext } from "./Capability";
import { ACTION_CONFIRMATION, STATION_LIMITS } from "../config";
import { failure, success } from "../execution/TaskResult";
import { normalizeMinecraftName } from "../shared/helper";
import { stationInventory, waitForStation, withStation, type StationResult } from "../runtime/StationInteraction";
import { windowCapacity, type WindowSnapshot } from "../runtime/ServerWindowObservation";
import type { ConfirmationTiming } from "../runtime/waitForConfirmation";

export function furnaceContents(state: WindowSnapshot) {
  const remaining = state.properties[0], total = state.properties[3], progress = state.properties[2];
  return { input: state.slots[0] ?? null, fuel: state.slots[1] ?? null, output: state.slots[2] ?? null,
    burning: remaining === undefined ? null : remaining > 0,
    progress: total && progress !== undefined ? Math.round(Math.min(1, Math.max(0, progress / total)) * 100) / 100 : null };
}
export class GetFurnaceContentsCapability implements Capability<Record<string, never>, StationResult> {
  readonly name = "get_furnace_contents";
  readonly inputSchema = z.object({}).strict();
  constructor(private readonly timing: ConfirmationTiming = ACTION_CONFIRMATION) {}
  execute(_input: Record<string, never>, context: ExecutionContext) {
    return withStation("furnace", context, async session => success(furnaceContents(session.snapshot())), this.timing);
  }
}

export interface UseFurnaceInput { inputItem: string; quantity: number; fuel: string }
export class UseFurnaceCapability implements Capability<UseFurnaceInput, StationResult> {
  readonly name = "use_furnace";
  readonly defaultTimeoutMs = STATION_LIMITS.furnaceTimeoutMs;
  readonly inputSchema = z.object({
    inputItem: z.string().trim().min(1).describe('Item to smelt. Currently supports "raw_iron" -> "iron_ingot".'),
    quantity: z.number().int().positive().max(STATION_LIMITS.maxSmeltQuantity).describe("Number of input items to smelt in this call."),
    fuel: z.string().trim().min(1).describe('Fuel from bot inventory. Currently supports "coal"; amount is calculated automatically.'),
  }).strict();
  constructor(private readonly timing: ConfirmationTiming = ACTION_CONFIRMATION) {}
  execute(input: UseFurnaceInput, context: ExecutionContext) {
    if (normalizeMinecraftName(input.inputItem) !== "raw_iron" || normalizeMinecraftName(input.fuel) !== "coal") {
      return Promise.resolve(failure("INVALID_ARGUMENT", "This tool currently supports only raw_iron -> iron_ingot using coal."));
    }
    return withStation("furnace", context, async session => {
      const furnace = session.window as Furnace;
      const initial = session.snapshot(), before = stationInventory(session, initial);
      if (initial.slots.slice(0, 3).some(Boolean)) return failure("BLOCKED",
        "The furnace already contains items. They were left unchanged; use an empty furnace.", { facts: furnaceContents(initial) });
      const fuelQuantity = Math.ceil(input.quantity / 8);
      if ((before.raw_iron ?? 0) < input.quantity || (before.coal ?? 0) < fuelQuantity) return failure("MISSING_ITEM",
        "The bot inventory does not contain the required raw iron and coal.", {
          facts: { required: { raw_iron: input.quantity, coal: fuelQuantity }, available: { raw_iron: before.raw_iron ?? 0, coal: before.coal ?? 0 } },
        });
      const data = session.bot.registry.itemsByName;
      if (windowCapacity(initial.slots.slice(furnace.inventoryStart, furnace.inventoryEnd), "iron_ingot", data.iron_ingot!.stackSize) < input.quantity) {
        return failure("BLOCKED", "Not enough room in bot inventory for all iron ingots.");
      }
      session.progress({ requested: input.quantity, inputInserted: null, fuelInserted: 0, collected: 0 });
      let state = await session.attempt("insert_input", () => furnace.putInput(data.raw_iron!.id, null, input.quantity));
      let inventory = stationInventory(session, state);
      const inserted = (before.raw_iron ?? 0) - (inventory.raw_iron ?? 0);
      session.progress({ inputInserted: inserted, remaining: furnaceContents(state) });
      if (inserted !== input.quantity || state.cursor !== null ||
        (state.slots[0]?.item === "raw_iron" ? state.slots[0].count : 0) +
        (state.slots[2]?.item === "iron_ingot" ? state.slots[2].count : 0) !== input.quantity) {
        return failure("ACTION_NOT_CONFIRMED", "The requested raw iron insertion was not confirmed. Inspect the furnace before retrying.");
      }
      session.progress({ fuelInserted: null });
      state = await session.attempt("insert_fuel", () => furnace.putFuel(data.coal!.id, null, fuelQuantity));
      inventory = stationInventory(session, state);
      const fuelInserted = (before.coal ?? 0) - (inventory.coal ?? 0);
      session.progress({ fuelInserted, remaining: furnaceContents(state) });
      if (fuelInserted !== fuelQuantity || state.cursor !== null) return failure("ACTION_NOT_CONFIRMED",
        "The fuel transfer was not confirmed. Some raw iron may remain in the furnace.");
      const cooked = await waitForStation(session, observed => {
        session.progress({ remaining: furnaceContents(observed) });
        return observed.slots[0] === null && observed.slots[2]?.item === "iron_ingot" && observed.slots[2].count === input.quantity;
      }, input.quantity * STATION_LIMITS.smeltItemMs + STATION_LIMITS.smeltMarginMs);
      if (!cooked) return failure("TIMEOUT", "The furnace did not produce all requested ingots before the cooking deadline. Inspect its contents.");
      session.progress({ collected: null });
      state = await session.attempt("collect_output", () => furnace.takeOutput());
      inventory = stationInventory(session, state);
      const collected = (inventory.iron_ingot ?? 0) - (before.iron_ingot ?? 0);
      const report = { requested: input.quantity, inputInserted: inserted, fuelInserted, collected, remaining: furnaceContents(state) };
      session.progress(report);
      if (collected !== input.quantity || state.slots[0] !== null || state.slots[2] !== null || state.cursor !== null) {
        return failure("ACTION_NOT_CONFIRMED", "All iron ingots were not confirmed in bot inventory. Inspect before retrying.");
      }
      session.expectInventory({ raw_iron: (before.raw_iron ?? 0) - input.quantity,
        coal: (before.coal ?? 0) - fuelQuantity, iron_ingot: (before.iron_ingot ?? 0) + input.quantity });
      return success(report);
    }, this.timing);
  }
}
