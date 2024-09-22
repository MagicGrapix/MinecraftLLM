
import { MyBotAction } from './Actions';
import { BotManager } from './BotManager';



const botManager = new BotManager();
botManager.initialize().then(() => {

  //botManager.bot.chat("Hello!!!");

  // Define a list of items with their quantities
  const itemsToGive = [
    { itemName: 'minecraft:diamond', amount: 10 },
    { itemName: 'minecraft:iron_ingot', amount: 20 },
    { itemName: 'minecraft:golden_apple', amount: 5 }
  ];


  const test = new MyBotAction(botManager);
  botManager.addAction(test);
  // Add the action to give the bot 10 diamonds
  //const giveDiamonds = new GiveMultipleItemsAction(itemsToGive);
  //botManager.addAction(giveDiamonds);

  // Execute the action queue
  botManager.execute();
});