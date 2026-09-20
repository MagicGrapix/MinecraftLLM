import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { normalizeMinecraftName } from "../shared/helper";
import type { Hand } from "../shared/types";

const OFF_HAND_SLOT = 45;

export interface ItemSnapshot {
  readonly name: string;
  readonly count: number;
  readonly metadata: number;
  readonly slot: number;
}

export function getHandItem(bot: Bot, hand: Hand): Item | null {
  if (hand === "hand") return bot.heldItem;
  return bot.inventory.slots[OFF_HAND_SLOT] ?? null;
}

export function countInventoryItem(bot: Bot, itemName: string): number {
  const normalizedName = normalizeMinecraftName(itemName);
  return bot.inventory
    .items()
    .filter((item) => item.name === normalizedName)
    .reduce((total, item) => total + item.count, 0);
}

export function snapshotInventory(bot: Bot): Readonly<Record<string, number>> {
  const snapshot: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    snapshot[item.name] = (snapshot[item.name] ?? 0) + item.count;
  }
  return snapshot;
}

export function inventoryDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const delta: Record<string, number> = {};

  for (const name of names) {
    const difference = (after[name] ?? 0) - (before[name] ?? 0);
    if (difference !== 0) delta[name] = difference;
  }
  return delta;
}

export function toItemSnapshot(item: Item): ItemSnapshot {
  return {
    name: item.name,
    count: item.count,
    metadata: item.metadata,
    slot: item.slot,
  };
}
