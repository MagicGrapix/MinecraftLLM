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

type NextBotAction = BotAction | undefined;

abstract class BotAction {
  abstract cleanUp(manager: BotManager): void;
  public abstract perform(manager: BotManager): Promise<BotAction | undefined>;
}


class Idleing extends BotAction {

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
}


const mcData = MinecraftData('1.20.1');

class MoveTo extends BotAction {

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

}

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

class WalkToPositionAction extends BotAction {
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

  cleanUp(manager: BotManager): void {
    manager.log('Cleaning up after walk action.');
    // Any cleanup logic can be placed here
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

  // Clean up after the digging action
  cleanUp(manager: BotManager): void {
    manager.log('Cleaning up after digging action.');
    // Any additional cleanup logic can be placed here
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
  //botManager.pushAction(new Loop(new MoveToRandom()));

  const findWoodAction = new FindNearestWoodAction();
  botManager.addAction(findWoodAction);

  botManager.execute();
});


/*
// List of wood types the bot will attempt to pick up
const woodTypes = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log'
];

// Function to find and chop the nearest tree
function findAndChopTree() {
  const block = bot.findBlock({
    matching: (block) => woodTypes.includes(block.name),
    maxDistance: 64 // Search for trees within a 64-block radius
  });

  if (block) {
    bot.chat(`Found a tree! Going to chop ${block.name}.`);
    goToAndChop(block.position);
  } else {
    bot.chat('No trees found nearby. Looking again in 5 seconds.');
    setTimeout(findAndChopTree, 5000); // Look again after 5 seconds
  }
}

// Function to move to a tree and start chopping
function goToAndChop(position: Vec3) {
  const goal = new goals.GoalBlock(position.x, position.y, position.z);
  bot.pathfinder.setGoal(goal, true);
  bot.chat('Going to tree...');

  // Debugging: monitor pathfinding progress
  bot.on('path_update', (r) => {
    if (r.status === 'noPath') {
      console.log('No path to the tree.');
      setTimeout(findAndChopTree, 5000); // Look for another tree if no path is found
    } else {
      console.log(`Pathfinding to the tree. Status: ${r.status}`);
    }
  });

  bot.once('goal_reached', () => {
    bot.chat('Reached the tree. Starting to chop...');
    chopTree(position);
  });

  // In case the bot doesn't reach the goal, add a timeout fallback
  setTimeout(() => {
    if (bot.pathfinder.isMoving()) {
      bot.chat('Still moving, something might be wrong.');
    }
  }, 10000);
}

// Function to chop wood blocks (tree logs) until the tree is gone
function chopTree(position: Vec3) {
  const block = bot.blockAt(position);
  bot.chat('Chopping the tree.');
  if (block && woodTypes.includes(block.name)) {
    bot.dig(block, true).then(() => {
      bot.chat(`Chopped ${block.name}. Checking for more wood...`);

      // Check above the block for more wood (tree trunk upwards)
      const aboveBlock = bot.blockAt(position.offset(0, 1, 0));
      if (aboveBlock && woodTypes.includes(aboveBlock.name)) {
        chopTree(aboveBlock.position); // Continue chopping upwards
      } else {
        bot.chat('Tree chopped down. Looking for another tree.');
        findAndChopTree(); // Find a new tree after finishing the current one
      }
    });
  } else {
    bot.chat('Could not chop the block. Looking for another tree.');
    findAndChopTree();
  }
}

console.log("start execution");
// Check for nearby wood items every 5 seconds

// Start execution and look for nearby wood items every 5 seconds
setInterval(() => findAndChopTree(), 5000);
*/