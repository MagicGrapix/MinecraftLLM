import type { Bot } from "mineflayer";
import { Movements } from "mineflayer-pathfinder";
import { GOTO_DEFAULTS } from "../config";
import type { Position } from "../shared/types";

export interface GotoMovementOptions {
  canDig?: boolean;
  canPlace?: boolean;
}

export function createGotoMovements(
  bot: Bot,
  target: Position,
  options: GotoMovementOptions,
): Movements {
  const movements = new Movements(bot);
  movements.canDig = options.canDig ?? GOTO_DEFAULTS.canDig;
  const canPlace = options.canPlace ?? GOTO_DEFAULTS.canPlace;
  movements.allow1by1towers = canPlace;
  movements.scafoldingBlocks = canPlace
    ? GOTO_DEFAULTS.scaffoldingItems.flatMap((name) => {
        const item = bot.registry.itemsByName[name];
        return item ? [item.id] : [];
      })
    : [];
  movements.digCost = GOTO_DEFAULTS.digCost;
  movements.placeCost = GOTO_DEFAULTS.placeCost;

  // Leave the requested block for the explicit dig/use/craft task.
  movements.exclusionAreasBreak.push((block) =>
    block.position.x === Math.floor(target.x) &&
    block.position.y === Math.floor(target.y) &&
    block.position.z === Math.floor(target.z)
      ? 100
      : 0,
  );
  for (const block of bot.registry.blocksArray) {
    if (
      ["crafting_table", "furnace", "blast_furnace", "smoker", "chest", "trapped_chest", "ender_chest", "barrel"].includes(block.name) ||
      block.name.endsWith("_bed") || block.name.endsWith("shulker_box")
    ) {
      movements.blocksCantBreak.add(block.id);
    }
  }
  return movements;
}

export function gotoMovementFacts(bot: Bot, movements: Movements) {
  return {
    canDig: movements.canDig,
    canPlace: movements.scafoldingBlocks.length > 0,
    allow1by1towers: movements.allow1by1towers,
    scaffolding: {
      allowedItems: movements.scafoldingBlocks.map((id) => bot.registry.items[id]?.name ?? String(id)),
      availableCount: movements.countScaffoldingItems(),
    },
  };
}
