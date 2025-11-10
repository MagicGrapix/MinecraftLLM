//import { Item } from "minecraft-data";
import { Action, BotManager } from "./BotManager";

import * as md from 'minecraft-data';
import { Bot } from "mineflayer";
import * as pm from 'prismarine-item';
import { computeInventoryDiff, getInventoryQuantities } from "./Utils";
import { Vec3 } from "vec3";



// Define the `GiveItemsAction` class that will extend from `BotAction`.
export class GiveItemsAction extends Action {
  private items: { name: string, count: number }[];

  constructor(manager: BotManager, items: { name: string, count: number }[]) {
    super(manager);
    this.items = items;
  }

  // The main logic to give items to the bot.
  public async execute(): Promise<void> {
    return new Promise(async (resolve, reject) => {

      if (!this.items || this.items.length === 0) {
        reject("No items specified for giving.");
        return;
      }

      const oldInventorySnapshot = getInventoryQuantities(this.manager.bot);

      // For each item in the list, use the `/give` command to give it to the bot.
      this.items.forEach(item => {
        this.manager.chat(`/give ${this.manager.bot.username} ${item.name} ${item.count}`);
      });

      // we check that the items are well added to the bot's inventory
      let counter = 0;
      let completed = false;
      while (counter < 10 && !completed) {
        await new Promise<void>(resolveInner => setTimeout(() => {
          const currentInventorySnapshot = getInventoryQuantities(this.manager.bot);
          const diff = computeInventoryDiff(oldInventorySnapshot, currentInventorySnapshot);
          let allAddedItemsArePresent: boolean = true;
          for (const item of this.items) {
            const addedDiff = diff.added.get(item.name);
            const changedDiff = diff.changed.get(item.name);
            if ((addedDiff && addedDiff != item.count) || (changedDiff && (changedDiff.to - changedDiff.from) != item.count)) {
              allAddedItemsArePresent = false;
            }
          }

          if (allAddedItemsArePresent) {
            console.debug(`all items found after ${counter + 1} trials.`);
            completed = true;
            resolveInner();
            resolve();
          } else {
            resolveInner();
          }
        }, 100));
        counter++;
      }

      if (!completed) {
        reject();
      }

    });
  }
}


export class SelectItemAction extends Action {
  private blockName: string;

  constructor(manager: BotManager, blockName: string) {
    super(manager);
    this.blockName = blockName;
  }

  public execute(): Promise<void> {

    return new Promise<void>((resolve, reject) => {
      // Find the desired block in the bot's inventory.
      const item = this.manager.bot.inventory.items().find(item => item.name == this.blockName);
      if (item) {
        // If the block is found, equip it in the hand.
        this.manager.bot.equip(item, 'hand').then(() => {
          console.debug(`Equipped ${this.blockName} successfully.`);
          resolve();
        }).catch((reason) => {
          //console.error(`Failed to equip ${this.blockName}:`, reason);
          //this.failed(`Failed to equip block ${this.blockName}`);
          reject(`${reason}: Failed to equip block ${this.blockName}`);
        });

      } else {
        // If the block is not found, fail the action.
        //console.error(`Block ${this.blockName} not found in inventory.`);
        //this.failed(`Block ${this.blockName} not found in inventory.`);
        reject(`Block ${this.blockName} not found in inventory.`);
      }
    });

  }
}

export class ClearInventoryAction extends Action {

  public async execute(): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      const items = this.manager.bot.inventory.items();
      if (items.length === 0) {
        console.log('Inventory is already empty.');
        resolve();
        return;
      }

      try {
        // Iterate through each item and toss it

        for (const item of items) {
          await this.manager.bot.tossStack(item).then(() => {
            console.debug(`Tossed item: ${item.name} x${item.count}`);
          }).catch((reason) => {
            console.error(`Failed tossing item: ${item.name} x${item.count}. Reason: ${reason}`);
          });
        }

        // Verify that the inventory is now empty 
        if (this.manager.bot.inventory.items().length === 0) {
          console.debug('Inventory successfully cleared.');
          resolve();
        } else {
          console.error(`Failed to clear inventory completely. ${this.manager.bot.inventory.items().length}`);
          reject();
          //this.failed('Failed to clear inventory completely.');
        }
      } catch (error: any) {
        console.error(`Error while clearing inventory: ${error.message}`);
        reject(`Error while clearing inventory: ${error.message}`)
        //this.failed(`Error while clearing inventory: ${error.message}`);
      }
    });
  }

}

export enum PlaceBlockStatus {
  Ok,
  NoBase,
  EmptyHands,
  Busy,
}


export class PlaceBlockAction extends Action {
  private targetPosition: Vec3; //the position on which the block will be placed

  constructor(manager: BotManager, targetPosition: Vec3) {
    super(manager);
    this.targetPosition = targetPosition; // Use the given block coordinates directly
  }

  public async execute(): Promise<void> {

    return new Promise<void>(async (resolve, reject) => {

      const bot = this.manager.bot;

      const currentTargetBlock = bot.blockAt(this.targetPosition);
      if (currentTargetBlock && currentTargetBlock.boundingBox !== 'empty') {
        reject(PlaceBlockStatus.Busy);
        return;
      }

      // Check if the bot has a selected block in its hand
      const selectedBlock = bot.heldItem;
      if (!selectedBlock) {
        reject(PlaceBlockStatus.EmptyHands);
        return;
      }

      //check we have a block bellow to place on
      const baseBlock = bot.blockAt(this.targetPosition.offset(0, -1, 0));
      if (!baseBlock) {
        reject(PlaceBlockStatus.NoBase);
        return;
      }

      try {
        // Place the block on top of the target block (use the top face of the target block)
        await bot.placeBlock(baseBlock, new Vec3(0, 1, 0));
        console.log(`Placed block ${selectedBlock.name} at ${this.targetPosition}`);
        resolve();
      } catch (error: any) {
        reject(`Failed to place block: ${error.message}`);
      }
    });

  }
}




// - Build(Structure)

// - Place block(Position)



// - Break block(Position)
// - Goto(Position | Locate(item | entity))
// - DigBlock(Position | Locate(item | entity))
// - Equip(item)
// - Drop(item)
// - PickUp(Position | Locate(item | entity))
// (- UseItem(item, Position | entity))
// - Craft2x2(item)