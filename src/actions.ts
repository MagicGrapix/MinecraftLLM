//import { Item } from "minecraft-data";
import { BotAction, BotManager } from "./BotManager";

import * as md from 'minecraft-data';
import { Bot } from "mineflayer";
import * as pm from 'prismarine-item';
import { computeInventoryDiff, getInventoryQuantities } from "./Utils";
import { Vec3 } from "vec3";

// Example concrete class extending BotAction
export class MyBotAction extends BotAction {
  async execute(): Promise<void> {
    // Custom logic here
    this.manager.chat('Hello world!');
  }

  // Override specific methods
  chat(username: string, message: string): void {
    console.log(`Chat event: ${username} said ${message}`);
    this.complete();
  }

  // Override other methods as needed
  error(err: Error): void {
    console.error(`Custom error handling: ${err.message}`);
  }
}


// Define the `GiveItemsAction` class that will extend from `BotAction`.
export class GiveItemsAction extends BotAction {
  private items: { name: string, count: number }[];

  constructor(manager: BotManager, items: { name: string, count: number }[]) {
    super(manager);
    this.items = items;
  }

  // The main logic to give items to the bot.
  public async execute(): Promise<void> {
    if (!this.items || this.items.length === 0) {
      this.failed("No items specified for giving.");
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
      await new Promise<void>(resolve => setTimeout(() => {
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
          this.complete();
          completed = true;
        }
        resolve();
      }, 100));
      counter++;
    }
    this.failed();
  }
}


export class SelectBlockAction extends BotAction {
  private blockName: string;

  constructor(manager: BotManager, blockName: string) {
    super(manager);
    this.blockName = blockName;
  }

  public execute(): void {

    // Find the desired block in the bot's inventory.
    const item = this.manager.bot.inventory.items().find(item => item.name == this.blockName);

    if (item) {
      // If the block is found, equip it in the hand.
      this.manager.bot.equip(item, 'hand').then(() => {
        console.debug(`Equipped ${this.blockName} successfully.`);
        this.complete();
      }).catch((reason) => {
        console.error(`Failed to equip ${this.blockName}:`, reason);
        this.failed(`Failed to equip block ${this.blockName}`);
      });

    } else {
      // If the block is not found, fail the action.
      console.error(`Block ${this.blockName} not found in inventory.`);
      this.failed(`Block ${this.blockName} not found in inventory.`);
    }
  }
}

export class ClearInventoryAction extends BotAction {

  public async execute(): Promise<void> {
    const items = this.manager.bot.inventory.items();
    if (items.length === 0) {
      console.log('Inventory is already empty.');
      this.complete();
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
        this.complete();
      } else {
        console.error(`Failed to clear inventory completely. ${this.manager.bot.inventory.items().length}`);
        this.failed('Failed to clear inventory completely.');
      }
    } catch (error: any) {
      console.error(`Error while clearing inventory: ${error.message}`);
      this.failed(`Error while clearing inventory: ${error.message}`);
    }
  }

}


export class PlaceBlockAction extends BotAction {
  private targetPosition: Vec3;

  constructor(manager: BotManager, targetPosition: Vec3) {
    super(manager);
    this.targetPosition = targetPosition; // Use the given block coordinates directly
  }

  public async execute(): Promise<void> {
    const bot = this.manager.bot;

    // Check if the bot has a selected block in its hand
    const selectedBlock = bot.heldItem;
    if (!selectedBlock) {
      console.error('No block selected to place.');
      this.failed('No block selected to place.');
      return;
    }

    try {
      // Get the block at the target position
      const targetBlock = bot.blockAt(this.targetPosition);

      // Ensure that we have a valid block to place on
      if (!targetBlock) {
        console.error('Invalid target position for block placement.');
        this.failed('Invalid target position for block placement.');
        return;
      }

      // Check if the block above the target position is air or empty (where we will place the block)
      const aboveTargetBlock = bot.blockAt(this.targetPosition.offset(0, 1, 0));
      if (aboveTargetBlock && aboveTargetBlock.boundingBox !== 'empty') {
        console.error('Block space above target is not empty.');
        this.failed('Cannot place block; target space is occupied.');
        return;
      }

      // Place the block on top of the target block (use the top face of the target block)
      await bot.placeBlock(targetBlock, new Vec3(0, 1, 0));
      console.log(`Placed block ${selectedBlock.name} at ${this.targetPosition}`);
      this.complete();
    } catch (error: any) {
      console.error(`Failed to place block: ${error.message}`);
      this.failed(`Failed to place block: ${error.message}`);
    }
  }
}
