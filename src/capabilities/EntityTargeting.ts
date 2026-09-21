import type { Bot } from "mineflayer";

const SURVIVAL_ENTITY_INTERACTION_RANGE = 3;
const CREATIVE_ENTITY_INTERACTION_RANGE = 5;

export function entityInteractionRange(bot: Bot): number {
  return bot.game?.gameMode === "creative"
    ? CREATIVE_ENTITY_INTERACTION_RANGE
    : SURVIVAL_ENTITY_INTERACTION_RANGE;
}

export function isEntityVisibleAtCursor(
  bot: Bot,
  entityId: number,
  maxDistance: number,
): boolean {
  return bot.entityAtCursor(maxDistance)?.id === entityId;
}
