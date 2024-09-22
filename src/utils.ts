import { Bot } from "mineflayer";
import { mcData } from "./Types";




function listAllBlocks() {
  // Iterate through all blocks and print their names in the desired format
  const blockNames = Object.values(mcData.blocks).map(block => `minecraft:${block.name}`);
  console.log('Available Blocks:');
  console.log(blockNames.join(', ')); // Join with a comma for easy viewing
  return blockNames;
}

// Function to display the bot's inventory
function displayInventory(bot: Bot) {
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
