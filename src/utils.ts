import { Bot } from "mineflayer";
import { mcData } from "./Types";
import { Vec3 } from "vec3";




function listAllBlocks() {
  // Iterate through all blocks and print their names in the desired format
  const blockNames = Object.values(mcData.blocks).map(block => `minecraft:${block.name}`);
  console.log('Available Blocks:');
  console.log(blockNames.join(', ')); // Join with a comma for easy viewing
  return blockNames;
}

// Function to display the bot's inventory
export function displayInventory(bot: Bot) {
  if (bot.inventory) {
    const items = bot.inventory.items(); // Get an array of items in the inventory

    if (items.length > 0) {
      console.log('Inventory Items:');
      items.forEach(item => {
        console.log(`${item.count} x ${item.name} (Slot: ${item.slot})`);
      });
    } else {
      console.log('The bot\'s inventory is empty.');
    }
  } else {
    console.log('Bot inventory is not available.');
  }
}


/**
 * Get a set of items and their overall quantities in the bot's inventory.
 * 
 * @param bot - The Mineflayer bot instance.
 * @returns A Map with item names as keys and their overall quantities as values.
 */
export function getInventoryQuantities(bot: Bot): Map<string, number> {
  // Create a map to hold item names and their corresponding quantities.
  const inventoryQuantities = new Map<string, number>();

  // Iterate through the items in the bot's inventory.
  for (const item of bot.inventory.items()) {
    const itemName = item.name;
    const currentQuantity = inventoryQuantities.get(itemName) || 0;

    // Add the item's count to the current quantity in the map.
    inventoryQuantities.set(itemName, currentQuantity + item.count);
  }

  return inventoryQuantities;
}

/**
 * Computes the difference between two inventories.
 * 
 * @param initialInventory - The initial inventory map with item names and their quantities.
 * @param newInventory - The new inventory map with item names and their quantities.
 * @returns An object containing added, removed, and changed items.
 */
export function computeInventoryDiff(
  initialInventory: Map<string, number>,
  newInventory: Map<string, number>
) {
  // Object to store the differences
  const diff = {
    added: new Map<string, number>(),
    removed: new Map<string, number>(),
    changed: new Map<string, { from: number; to: number }>()
  };

  // Check for added or changed items in the new inventory
  for (const [itemName, newQuantity] of newInventory.entries()) {
    const initialQuantity = initialInventory.get(itemName);

    if (initialQuantity === undefined) {
      // Item is new and added to the inventory
      diff.added.set(itemName, newQuantity);
    } else if (initialQuantity !== newQuantity) {
      // Item quantity has changed
      diff.changed.set(itemName, { from: initialQuantity, to: newQuantity });
    }
  }

  // Check for removed items in the new inventory
  for (const [itemName, initialQuantity] of initialInventory.entries()) {
    if (!newInventory.has(itemName)) {
      // Item has been removed from the inventory
      diff.removed.set(itemName, initialQuantity);
    }
  }

  return diff;
}


/**
 * Get the current block position of the bot.
 * 
 * @param bot - The Mineflayer bot instance.
 * @returns The bot's block position as a Vec3 object.
 */
export function getBotBlockPosition(bot: Bot): Vec3 {
  // The bot's exact position can be accessed through bot.entity.position
  // We need to round each component to get the block position.
  const position = bot.entity.position;
  const blockPosition = position.floored(); // Round down to the nearest whole number.

  return blockPosition;
}


/**
 * Scans surrounding blocks within a radius and returns a map of block names to their positions.
 * @param bot - The Mineflayer bot instance.
 * @param radius - The search radius.
 * @returns A map where the keys are block names and the values are arrays of their positions.
 */
function surroundingBlockInventory(bot: Bot, radius: number): Map<string, Vec3[]> {
  const blockInventory = new Map<string, Vec3[]>();
  const botPos = bot.entity.position;

  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      for (let z = -radius; z <= radius; z++) {
        const position = botPos.offset(x, y, z);
        const block = bot.blockAt(position);

        if (block && block.name) {
          // Add the position to the map under the block name
          if (!blockInventory.has(block.name)) {
            blockInventory.set(block.name, []);
          }
          blockInventory.get(block.name)?.push(position);
        }
      }
    }
  }

  return blockInventory;
}