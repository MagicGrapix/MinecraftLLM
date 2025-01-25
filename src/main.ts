
import './Types';
import { ClearInventoryAction, GiveItemsAction, PlaceBlockAction, SelectBlockAction } from './Actions';
import { BotManager } from './BotManager';
import { setDebugEnabled } from './Logger';
import { getBotBlockPosition } from './Utils';

setDebugEnabled(true);

const botManager = new BotManager();
botManager.initialize().then(() => {

  //botManager.bot.chat("Hello!!!");

  // Define a list of items with their quantities
  const itemsToGive = [
    { name: 'minecraft:diamond', count: 10 },
    { name: 'minecraft:iron_ingot', count: 20 },
    { name: 'minecraft:golden_apple', count: 5 }
  ];
  botManager.bot.chat("Hello world!");

  botManager.addAction(new ClearInventoryAction(botManager));
  botManager.addAction(new GiveItemsAction(botManager, itemsToGive));
  botManager.addAction(new SelectBlockAction(botManager, 'diamond'));
  //todo check block is placable!
  botManager.addAction(new PlaceBlockAction(botManager, getBotBlockPosition(botManager.bot)));

  // Add the action to give the bot 10 diamonds
  //const giveDiamonds = new GiveMultipleItemsAction(itemsToGive);
  //botManager.addAction(giveDiamonds);

  // Execute the action queue
  botManager.execute();
});