import type { Entity } from "prismarine-entity";
import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import {
  getHandItem,
  inventoryDelta,
  snapshotInventory,
} from "../runtime/InventoryAdapter";
import { normalizeMinecraftName } from "../shared/helper";
import { HandSchema, type Hand } from "../shared/types";
import type { Capability, ExecutionContext } from "./Capability";

const UseItemInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      expectedItem: z.string().trim().min(1),
      hand: HandSchema,
      mode: z.literal("instant"),
    })
    .strict(),
  z
    .object({
      expectedItem: z.string().trim().min(1),
      hand: HandSchema,
      mode: z.literal("hold_then_release"),
      holdTicks: z.number().int().positive().max(1_200),
    })
    .strict(),
]);

export type UseItemInput = z.infer<typeof UseItemInputSchema>;

export interface UseItemOutput {
  item: string;
  hand: Hand;
  mode: UseItemInput["mode"];
  requestSent: true;
  effectConfirmed: boolean;
  evidence: readonly string[];
  inventoryDelta: Readonly<Record<string, number>>;
}

export class UseItemCapability
  implements Capability<UseItemInput, UseItemOutput>
{
  readonly name = "use_item";
  readonly inputSchema: z.ZodType<UseItemInput> = UseItemInputSchema;

  async execute(
    input: UseItemInput,
    context: ExecutionContext,
  ): Promise<TaskResult<UseItemOutput>> {
    const bot = context.runtime.bot;
    const itemName = normalizeMinecraftName(input.expectedItem);
    const heldBefore = getHandItem(bot, input.hand);
    if (!heldBefore || heldBefore.name !== itemName) {
      return failure(
        "MISSING_ITEM",
        `Expected "${itemName}" in ${input.hand}, but it is not equipped.`,
        {
          facts: {
            expectedItem: itemName,
            actualItem: heldBefore?.name ?? null,
            hand: input.hand,
          },
        },
      );
    }

    const beforeInventory = snapshotInventory(bot);
    let projectileObserved = false;
    const observeEntity = (entity: Entity): void => {
      if (
        isProjectile(entity.name) &&
        entity.position.distanceTo(bot.entity.position) <= 4
      ) {
        projectileObserved = true;
      }
    };
    const stopUsing = (): void => bot.deactivateItem();

    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", stopUsing, { once: true });
    bot.on("entitySpawn", observeEntity);

    try {
      bot.activateItem(input.hand === "off-hand");

      const ticks =
        input.mode === "hold_then_release" ? input.holdTicks : 2;
      await waitForTicks(bot.waitForTicks.bind(bot), ticks, context.signal);
      bot.deactivateItem();
      await waitForTicks(bot.waitForTicks.bind(bot), 2, context.signal);

      const afterInventory = snapshotInventory(bot);
      const delta = inventoryDelta(beforeInventory, afterInventory);
      const heldAfter = getHandItem(bot, input.hand);
      const evidence: string[] = [];
      if (Object.keys(delta).length > 0) evidence.push("inventory_changed");
      if (heldAfter?.name !== heldBefore.name) evidence.push("item_replaced");
      if (projectileObserved) evidence.push("projectile_observed");

      return success({
        item: itemName,
        hand: input.hand,
        mode: input.mode,
        requestSent: true,
        effectConfirmed: evidence.length > 0,
        evidence,
        inventoryDelta: delta,
      });
    } finally {
      bot.deactivateItem();
      bot.removeListener("entitySpawn", observeEntity);
      context.signal.removeEventListener("abort", stopUsing);
    }
  }
}

async function waitForTicks(
  wait: (ticks: number) => Promise<void>,
  ticks: number,
  signal: AbortSignal,
): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    signal.throwIfAborted();
    await wait(1);
  }
  signal.throwIfAborted();
}

function isProjectile(name: string | undefined): boolean {
  return (
    name === "arrow" ||
    name === "ender_pearl" ||
    name === "egg" ||
    name === "snowball" ||
    name === "potion"
  );
}
