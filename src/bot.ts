import { connect } from 'http2';
import { Bot, createBot } from 'mineflayer'
import { goals, Movements, pathfinder } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import MinecraftData from 'minecraft-data';

enum BotState {
  Moving,
  Idle,
  Digging,
}


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



abstract class BotAction {

  protected manager: BotManager;
  constructor(_manager: BotManager) {
    this.manager = _manager;
  }

  onChat(): void { }

  // launch the logic of the task
  public abstract execute(): Promise<void>;
}



/*class Idleing extends BotAction {

  cleanUp(manager: BotManager): void {
    clearTimeout(this.timeout);
  }

  private duration: number;
  private timeout: NodeJS.Timeout | undefined;

  constructor(_duration?: number) {
    super();
    this.duration = _duration ?? 2000;
  }

  perform = (manager: BotManager): Promise<BotAction | undefined> => {
    return new Promise((resolve, reject) => {
      manager.log(`Going idle for ${this.duration} ms`);
      this.timeout = setTimeout(() => {
        manager.log('Exiting idle');
        resolve(new Idleing(this.duration));
      }, this.duration);
    });
  }
}*/


const mcData = MinecraftData('1.20.1');

/*class MoveTo extends BotAction {

  protected target: Vec3;
  constructor(_target: Vec3) {
    super();
    this.target = _target;
  }

  private goalReached: ((goal: goals.Goal) => void) | undefined;
  private timeout: NodeJS.Timeout | undefined;

  cleanUp(manager: BotManager): void {
    console.log("clean up?");
    if (this.goalReached) {
      manager.bot.removeListener('goal_reached', this.goalReached);
    }
    clearTimeout(this.timeout);
  }

  public perform = (manager: BotManager): Promise<BotAction | undefined> => {
    return new Promise((resolve, reject) => {

      const goal = new goals.GoalXZ(this.target.x, this.target.y);
      manager.bot.pathfinder.goto(goal, (error) => {
        console.log("goto " + error?.message)
      });

      manager.log(`Moving from ${manager.bot.entity.position.toString()} to ${this.target.toString()}`);

      this.goalReached = (goal: goals.Goal) => {
        manager.log('Reached my goal!');
        resolve(undefined);
      }

      manager.bot.once('goal_reached', this.goalReached);

      // In case the bot doesn't reach the goal, add a timeout fallback
      this.timeout = setTimeout(() => {
        manager.log('Timout: It has been a while and I did not reached my target...');
        if (manager.bot.pathfinder.isMoving()) {
          manager.log('Still moving, something might be wrong.');
        }
        reject(`failed to reach target position ${this.target}`);
      }, 10000);
    });
  }

}*/

/*class MoveToRandom extends MoveTo {

  moveTo: MoveTo;

  constructor() {
    super();
    this.moveTo = new MoveTo();
  }

  perform = (manager: BotManager): Promise<BotAction | undefined> => {
    // Random nearby position
    this.target = manager.bot.entity.position.offset(
      Math.random() * 2 - 1, // Random X offset (-5 to 5)
      0,                      // Y remains the same
      Math.random() * 2 - 1   // Random Z offset (-5 to 5)
    );
    return super.perform(manager);
  }
}*/

/*class WalkToPositionAction extends BotAction {
  private position: Vec3;

  constructor(position: Vec3) {
    super();
    this.position = position;
  }

  async perform(manager: BotManager): Promise<BotAction | undefined> {
    manager.log(`Walking to position: ${this.position}`);

    try {
      await manager.bot.pathfinder.goto(new goals.GoalBlock(this.position.x, this.position.y, this.position.z));
      manager.log('Arrived at destination.');
      return undefined;  // No follow-up action
    } catch (err) {
      manager.log('Failed to reach the destination.');
      return undefined;  // No follow-up action, could handle retries here
    }
  }

}

class Loop extends BotAction {

  private loopAction: BotAction;
  constructor(action: BotAction) {
    super();
    this.loopAction = action;
  }

  cleanUp(manager: BotManager): void {
    this.loopAction.cleanUp(manager);
  }

  perform(manager: BotManager): Promise<BotAction | undefined> {
    return this.loopAction.perform(manager).finally(() => {
      return this.loopAction;
    });
  }
}


class DigBlockAction extends BotAction {
  private blockPosition: Vec3;

  constructor(blockPosition: Vec3) {
    super();
    this.blockPosition = blockPosition;
  }

  // Perform the digging action
  async perform(manager: BotManager): Promise<BotAction | undefined> {
    manager.log(`Attempting to dig block at position: ${this.blockPosition}`);

    // Get the block at the specified position
    const block = manager.bot.blockAt(this.blockPosition);

    // If the block is undefined or air, stop
    if (!block || block.name === 'air') {
      manager.log(`No block found at position: ${this.blockPosition} or block is air.`);
      return undefined;  // No follow-up action
    }

    try {
      // Start digging the block
      await manager.bot.dig(block);
      manager.log(`Successfully dug block: ${block.name}`);
    } catch (err) {
      manager.log(`Failed to dig block at ${this.blockPosition}: ${err}`);
      return undefined;  // No follow-up action, could handle retries here
    }

    return undefined;  // No further action
  }

}

// A new action to find the nearest wood block
class FindNearestWoodAction extends BotAction {

  // Perform the action of finding and moving to the nearest wood block
  async perform(manager: BotManager): Promise<BotAction | undefined> {
    manager.log('Searching for the nearest wood block...');

    // Define the radius to search for blocks
    const radius = 30;


    // Find the nearest wood block within the given radius
    const block = manager.bot.findBlock({
      matching: (block) => {
        let name = mcData.blocksByName[block.name]?.name;
        return name ? name.includes('log') : false;
      },  // Matches all types of logs (wood)
      maxDistance: radius
    });

    if (!block) {
      manager.log('No wood block found within radius.');
      return undefined;  // No follow-up action
    }

    manager.log(`Found wood block at position: ${block.position}`);

    // Queue the next action to walk to the block and dig it
    const walkAction = new WalkToPositionAction(block.position);
    const digAction = new DigBlockAction(block.position);

    return walkAction.perform(manager).then(() => digAction);  // Chain actions: walk then dig
  }

  cleanUp(manager: BotManager): void {
    manager.log('Finished searching for wood block.');
  }
}*/

const IMMEDIATE_TASK_TIMEOUT: number = 4000;

class GiveItemAction extends BotAction {
  private itemName: string;
  private amount: number;

  /**
   * Constructor to initialize the item name and amount.
   * @param itemName - The Minecraft item name (e.g., 'minecraft:diamond').
   * @param amount - The amount of the item to give to the bot.
   */
  constructor(manager: BotManager, itemName: string, amount: number) {
    super(manager);
    this.itemName = itemName;
    this.amount = amount;
  }

  /**
   * Performs the action of giving the item to the bot.
   * @param manager - The BotManager instance to perform actions with the bot.
   * @returns A promise that resolves with no further actions.
   */
  async perform(): Promise<void> {
    let timeout: NodeJS.Timeout;

    return new Promise((resolve, reject) => {

      const onMessage = (jsonMsg: any) => {
        if (jsonMsg.translate === 'commands.give.success.single' || jsonMsg.translate === 'commands.give.success.multiple') {
          manager.log(`Successfully gave ${this.amount} of ${this.itemName} to the bot.`);
          clearTimeout(timeout); // Clear the timeout if successful
          manager.bot.off('message', onMessage); // Remove the event listener
          resolve(undefined); // Resolve the promise indicating action completion
        }
      };

      try {
        manager.log(`Attempting to give ${this.amount} of ${this.itemName} to the bot.`);

        // Construct the give command
        const giveCommand = `/give ${manager.bot.username} ${this.itemName} ${this.amount}`;

        // Attach the listener for chat message events
        manager.bot.on('message', onMessage);

        // Timeout to handle command failure
        timeout = setTimeout(() => {
          manager.bot.off('message', onMessage); // Clean up the event listener
          reject(new Error(`Failed to give item: Timed out after ${IMMEDIATE_TASK_TIMEOUT} ms.`)); // Reject the promise with an error
        }, IMMEDIATE_TASK_TIMEOUT);

        // Send the command to the server
        manager.bot.chat(giveCommand);
      } catch (error) {
        reject(error);
      } finally {
        // Always clean up the event listener, even on error or timeout
        manager.bot.off('message', onMessage);
      }
    });
  }

}


class GiveMultipleItemsAction extends BotAction {
  private items: Array<{ itemName: string; amount: number }>;

  /**
   * Constructor to initialize the list of items and their quantities.
   * @param items - An array of objects, each containing itemName and amount.
   * e.g., [{ itemName: 'minecraft:diamond', amount: 10 }, { itemName: 'minecraft:iron_ingot', amount: 5 }]
   */
  constructor(items: Array<{ itemName: string; amount: number }>) {
    super();
    this.items = items;
  }

  /**
   * Performs the action of giving multiple items to the bot.
   * @param manager - The BotManager instance to perform actions with the bot.
   * @returns A promise that resolves with no further actions.
   */
  async perform(manager: BotManager): Promise<BotAction | undefined> {
    for (const item of this.items) {
      try {
        console.error("here");
        await this.giveItem(manager, item.itemName, item.amount);
      } catch (error) {
        manager.log(`Failed to give ${item.amount} of ${item.itemName}: ${error}`);
        // Optionally, you could decide to stop further actions or handle this error differently.
      }
    }
    return undefined; // No follow-up action
  }

  /**
   * Helper function to give a single item to the bot with a specified amount.
   * @param manager - The BotManager instance to perform actions with the bot.
   * @param itemName - The Minecraft item name (e.g., 'minecraft:diamond').
   * @param amount - The amount of the item to give to the bot.
   * @returns A promise that resolves when the item is successfully given or rejects on failure.
   */
  private giveItem(manager: BotManager, itemName: string, amount: number): Promise<void> {
    let timeout: NodeJS.Timeout;

    return new Promise((resolve, reject) => {
      const onMessage = (jsonMsg: any) => {

        console.log(jsonMsg);
        if (jsonMsg.translate === 'commands.give.success.single' || jsonMsg.translate === 'commands.give.success.multiple') {
          //manager.log(`Successfully gave ${amount} of ${itemName} to the bot.`);
          clearTimeout(timeout); // Clear the timeout if successful
          manager.bot.off('message', onMessage); // Remove the event listener
          resolve(); // Resolve the promise indicating action completion
        }
      };

      try {
        manager.log(`Attempting to give ${amount} of ${itemName} to the bot.`);

        // Construct the give command
        const giveCommand = `/give ${manager.bot.username} ${itemName} ${amount}`;

        // Attach the listener for chat message events
        manager.bot.on('message', onMessage);

        // Timeout to handle command failure
        timeout = setTimeout(() => {
          manager.bot.off('message', onMessage); // Clean up the event listener
          reject(new Error(`Failed to give item: Timed out after ${IMMEDIATE_TASK_TIMEOUT} ms.`)); // Reject the promise with an error
        }, IMMEDIATE_TASK_TIMEOUT);

        // Send the command to the server
        manager.bot.chat(giveCommand);
      } catch (error) {
        reject(error);
      } finally {
        console.warn("here");
        // Always clean up the event listener, even on error or timeout
        manager.bot.off('message', onMessage);
      }
    });
  }




}


class BotManager {

  bot: Bot;
  currentBotState: BotState = BotState.Idle;
  currentBotAction: BotAction | undefined;
  actionsQueue: Array<BotAction> = new Array();


  constructor() {
    this.bot = createBot({
      host: 'localhost', // Minecraft server IP
      port: 25565,       // Minecraft server port (default 25565)
      username: 'bot',    // Minecraft bot username
      version: '1.20.1',
    });
  }

  log(msg: string): void {
    const msgWithDate = `${Date.now()}:` + msg;
    this.bot.chat(msgWithDate);
    console.log(msgWithDate);
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, _) => {
      this.bot.on('spawn', () => {

        this.bot.loadPlugin(pathfinder);
        // Initialize the bot's movements for pathfinding
        const defaultMove = new Movements(this.bot);
        defaultMove.allow1by1towers = true;

        //pathfinder(bot);
        this.bot.pathfinder.setMovements(defaultMove);
        console.log('Bot has spawned in the game.');

        /*const player = this.bot.players['GrapixMagique'].entity; // Replace 'playerName' with the actual player's name
        if (player) {
          this.bot.entity.position.set(player.position.x, player.position.y, player.position.z); // Teleport bot
          this.bot.lookAt(player.position); // Optional: Make bot look at the player
        } else {
          console.error("Couldn't find the player!");
        }*/
        this.bot.entity.position.set(-5.151, -60, -67.5);

        this.bot.chat('/effect give @s minecraft:invisibility 99999 1 true');
        this.bot.chat('/effect give @a saturation 99999 255 true');

        resolve();
      });

      this.bot.on('chat', (username, message) => {
        if (username === this.bot.username) return
        this.bot.chat(`Hello ${username}, you said: ${message}`);
      });

      this.bot.on('error', err => {
        console.error(`Error: ${err.message}`)
      });

      this.bot.on('end', () => {
        console.log('Bot disconnected from server.')
      });
    });
  }

  addAction(action: BotAction): void {
    this.actionsQueue.push(action);
  }

  execute = (): void => {
    const processNext = async () => {
      if (this.actionsQueue.length === 0) {
        console.log('No more actions. Exiting');
        return;  // Exit if the queue is empty
      }

      const action = this.actionsQueue.pop();
      console.log(`About to execute action ${action}`);

      try {
        const maybeFollowUp = await action?.perform(this);
        await action?.cleanUp(this);
        console.log(`Action executed. ${maybeFollowUp ? 'Returned a follow-up task' : ''}`);

        if (maybeFollowUp) {
          this.actionsQueue.unshift(maybeFollowUp);  // Add follow-up task to the front of the queue
        }
      } catch (error) {
        console.error(`Error executing action: ${error}. Continuing`);
      }

      // Schedule the next execution asynchronously
      setImmediate(processNext);
    };

    // Start processing actions asynchronously
    processNext();
  }

}

const botManager = new BotManager();
botManager.initialize().then(() => {

  botManager.bot.chat("Hello!!!");

  // Define a list of items with their quantities
  const itemsToGive = [
    { itemName: 'minecraft:diamond', amount: 10 },
    { itemName: 'minecraft:iron_ingot', amount: 20 },
    { itemName: 'minecraft:golden_apple', amount: 5 }
  ];

  // Add the action to give the bot 10 diamonds
  const giveDiamonds = new GiveMultipleItemsAction(itemsToGive);
  botManager.addAction(giveDiamonds);

  // Execute the action queue
  botManager.execute();
});