import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import {
  countInventoryItem,
  getHandItem,
  inventoryDelta,
  snapshotInventory,
} from "../runtime/InventoryAdapter";
import { normalizeMinecraftName } from "../shared/helper";
import { HandSchema, type Hand } from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

const CONSUMPTION_CONFIRMATION_TICKS = 80;
const DRINKABLE_ITEMS = new Set([
  "potion",
  "milk_bucket",
  "honey_bottle",
]);
const ALWAYS_EDIBLE_ITEMS = new Set([
  "golden_apple",
  "enchanted_golden_apple",
]);

export interface ConsumeInput {
  expectedItem: string;
  hand: Hand;
}

export interface ConsumeOutput {
  item: string;
  hand: Hand;
  countBefore: number;
  countAfter: number;
  foodBefore: number;
  foodAfter: number;
  healthBefore: number;
  healthAfter: number;
  effectsBefore: readonly number[];
  effectsAfter: readonly number[];
  inventoryDelta: Readonly<Record<string, number>>;
  returnedContainers: readonly string[];
}

export class ConsumeCapability
  implements Capability<ConsumeInput, ConsumeOutput>
{
  readonly name = "consume";
  readonly inputSchema: z.ZodType<ConsumeInput> = z
    .object({
      expectedItem: z.string().trim().min(1),
      hand: HandSchema,
    })
    .strict();

  async execute(
    input: ConsumeInput,
    context: ExecutionContext,
  ): Promise<TaskResult<ConsumeOutput>> {
    const bot = context.runtime.bot;
    const itemName = normalizeMinecraftName(input.expectedItem);
    const heldItem = getHandItem(bot, input.hand);

    if (!heldItem || heldItem.name !== itemName) {
      return failure(
        "MISSING_ITEM",
        `Expected "${itemName}" in ${input.hand}, but it is not equipped.`,
        {
          facts: {
            expectedItem: itemName,
            actualItem: heldItem?.name ?? null,
            hand: input.hand,
          },
        },
      );
    }

    const isFood = bot.registry.foodsByName[itemName] !== undefined;
    const isDrinkable = DRINKABLE_ITEMS.has(itemName);
    if (!isFood && !isDrinkable) {
      return failure(
        "NOT_CONSUMABLE",
        `Item "${itemName}" is not a supported consumable.`,
        { facts: { item: itemName } },
      );
    }

    if (
      bot.usingHeldItem ||
      (isFood &&
        bot.food === 20 &&
        !ALWAYS_EDIBLE_ITEMS.has(itemName) &&
        !isDrinkable)
    ) {
      return failure("BLOCKED", `Cannot consume "${itemName}" now.`, {
        retryable: true,
        facts: {
          usingHeldItem: bot.usingHeldItem,
          food: bot.food,
        },
      });
    }

    const inventoryBefore = snapshotInventory(bot);
    const countBefore = countInventoryItem(bot, itemName);
    const foodBefore = bot.food;
    const healthBefore = bot.health;
    const effectsBefore = effectIds(bot.entity.effects);
    const stopUsing = (): void => bot.deactivateItem();

    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", stopUsing, { once: true });
    bot.activateItem(input.hand === "off-hand");

    try {
      for (let tick = 0; tick < CONSUMPTION_CONFIRMATION_TICKS; tick += 1) {
        context.signal.throwIfAborted();
        await bot.waitForTicks(1);

        const inventoryAfter = snapshotInventory(bot);
        const countAfter = countInventoryItem(bot, itemName);
        const foodAfter = bot.food;
        const healthAfter = bot.health;
        const effectsAfter = effectIds(bot.entity.effects);
        const delta = inventoryDelta(inventoryBefore, inventoryAfter);

        if (
          countAfter !== countBefore ||
          foodAfter !== foodBefore ||
          healthAfter !== healthBefore ||
          !sameNumbers(effectsBefore, effectsAfter) ||
          Object.keys(delta).length > 0
        ) {
          return success({
            item: itemName,
            hand: input.hand,
            countBefore,
            countAfter,
            foodBefore,
            foodAfter,
            healthBefore,
            healthAfter,
            effectsBefore,
            effectsAfter,
            inventoryDelta: delta,
            returnedContainers: returnedContainers(delta),
          });
        }
      }

      return failure(
        "ACTION_NOT_CONFIRMED",
        `No server-side consumption of "${itemName}" was observed.`,
        {
          retryable: true,
          facts: { item: itemName, hand: input.hand },
        },
      );
    } finally {
      bot.deactivateItem();
      context.signal.removeEventListener("abort", stopUsing);
    }
  }
}

function effectIds(
  effects: Readonly<Record<number, unknown>>,
): readonly number[] {
  return Object.keys(effects).map(Number).sort((left, right) => left - right);
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function returnedContainers(
  delta: Readonly<Record<string, number>>,
): readonly string[] {
  return Object.entries(delta)
    .filter(
      ([name, count]) =>
        count > 0 &&
        (name === "glass_bottle" ||
          name === "bucket" ||
          name.endsWith("_bowl")),
    )
    .map(([name]) => name)
    .sort();
}
