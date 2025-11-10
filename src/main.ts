
import './Types';
import { ClearInventoryAction, GiveItemsAction, PlaceBlockAction, SelectItemAction } from './Actions';
import { ActionSequence, BotManager } from './BotManager';
import { setDebugEnabled } from './Logger';
import { getBotBlockPosition } from './Utils';

setDebugEnabled(true);

const botManager = new BotManager();
botManager.initialize().then(() => {

  // Define a list of items with their quantities
  const itemsToGive = [
    { name: 'minecraft:diamond_block', count: 10 },
    { name: 'minecraft:iron_ingot', count: 20 },
    { name: 'minecraft:golden_apple', count: 5 }
  ];
  botManager.bot.chat("Hello world!");

  /*botManager.addAction(new ClearInventoryAction(botManager));
  botManager.addAction(new GiveItemsAction(botManager, itemsToGive));
  botManager.addAction(new SelectItemAction(botManager, 'diamond_block'));
  botManager.addAction(new PlaceBlockAction(botManager, getBotBlockPosition(botManager.bot)));




  let actionSequence1 = new ActionSequence();
  let actionSequence2 = new ActionSequence();

  let actionSequence2 = actionSequence1.do(Action1, label).doIf(Action2, predicate).exec((Context)).doUntil(Action3, predicate).waitUntil(predicate).goto(label).exit().switch(actionSequence2);
  let actionSequence1 = ActionSequence.do(Action1, label).doIf(Action2, predicate).doUntil(Action3, predicate).goto(label).exit().switch();

  botManager.executeActionSequence(actionSequence1);
*/

  const actionSequence2 = new ActionSequence("ActionSequence2");
  const actionSequence = new ActionSequence("ActionSequence1", actionSequence2);

  actionSequence
    .do(new ClearInventoryAction(botManager))
    .do(new GiveItemsAction(botManager, itemsToGive))
    .do(new SelectItemAction(botManager, 'diamond_block'))
    .do(new PlaceBlockAction(botManager, getBotBlockPosition(botManager.bot)))
    .switch(actionSequence2);


  actionSequence2
    .label("start")
    .wait(2000)
    .exec(() => {
      return new Promise((resolve) => {
        console.info("waiting");
        resolve();
      });
    })
    .goto("start");


  ActionSequence.execute(actionSequence);

  // Execute the action queue
  //botManager.execute();
});