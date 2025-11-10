
import { Bot, createBot } from 'mineflayer';
import { Movements, pathfinder } from 'mineflayer-pathfinder';
import { IMMEDIATE_TASK_TIMEOUT } from './Types';
import { EventEmitter, on } from 'events';
import { BossBar, BotEvents, DisplaySlot, Effect, Instrument, Particle, Player, ScoreBoard, Team } from 'mineflayer';
import { goals, PartiallyComputedPath } from 'mineflayer-pathfinder';
import { Block } from 'prismarine-block';
import { ChatMessage } from 'prismarine-chat';
import { Entity } from 'prismarine-entity';
import { Window } from 'prismarine-windows';
import { Vec3 } from 'vec3';


export const botEventNames: Array<keyof BotEvents> = [
  'chat',
  'whisper',
  'actionBar',
  'error',
  'message',
  'messagestr',
  'unmatchedMessage',
  'inject_allowed',
  'login',
  'spawn',
  'respawn',
  'game',
  'title',
  'rain',
  'time',
  'kicked',
  'end',
  'spawnReset',
  'death',
  'health',
  'breath',
  'entitySwingArm',
  'entityHurt',
  'entityDead',
  'entityTaming',
  'entityTamed',
  'entityShakingOffWater',
  'entityEatingGrass',
  'entityHandSwap',
  'entityWake',
  'entityEat',
  'entityCriticalEffect',
  'entityMagicCriticalEffect',
  'entityCrouch',
  'entityUncrouch',
  'entityEquip',
  'entitySleep',
  'entitySpawn',
  'entityElytraFlew',
  'usedFirework',
  'itemDrop',
  'playerCollect',
  'entityAttributes',
  'entityGone',
  'entityMoved',
  'entityDetach',
  'entityAttach',
  'entityUpdate',
  'entityEffect',
  'entityEffectEnd',
  'playerJoined',
  'playerUpdated',
  'playerLeft',
  'blockUpdate',
  'blockUpdate:(x, y, z)', // Special case for 'blockUpdate' with coordinates
  'chunkColumnLoad',
  'chunkColumnUnload',
  'soundEffectHeard',
  'hardcodedSoundEffectHeard',
  'noteHeard',
  'pistonMove',
  'chestLidMove',
  'blockBreakProgressObserved',
  'blockBreakProgressEnd',
  'diggingCompleted',
  'diggingAborted',
  'move',
  'forcedMove',
  'mount',
  'dismount',
  'windowOpen',
  'windowClose',
  'sleep',
  'wake',
  'experience',
  'physicsTick',
  'physicTick', // Assuming this is a typo in the interface, it's included just in case
  'scoreboardCreated',
  'scoreboardDeleted',
  'scoreboardTitleChanged',
  'scoreUpdated',
  'scoreRemoved',
  'scoreboardPosition',
  'teamCreated',
  'teamRemoved',
  'teamUpdated',
  'teamMemberAdded',
  'teamMemberRemoved',
  'bossBarCreated',
  'bossBarDeleted',
  'bossBarUpdated',
  'resourcePack',
  'particle'
];

export class BotManager {
  bot: Bot;
  actionsQueue: Array<Action> = new Array();

  constructor() {
    this.bot = createBot({
      host: 'localhost', // Minecraft server IP
      port: 25565,       // Minecraft server port (default 25565)
      username: 'bot',    // Minecraft bot username
      version: '1.20.1',
    });
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, _) => {
      this.bot.on('spawn', () => {

        console.info('Bot spawning...');

        this.bot.loadPlugin(pathfinder);
        // Initialize the bot's movements for pathfinding
        const defaultMove = new Movements(this.bot);
        defaultMove.allow1by1towers = true;

        //pathfinder(bot);
        this.bot.pathfinder.setMovements(defaultMove);
        this.bot.entity.position.set(-2, -60, 7);

        this.bot.chat('/effect clear @s minecraft:invisibility');
        //this.bot.chat('/effect give @a saturation 99999 255 true');

        resolve();
      });

      /*this.bot.on('chat', (username, message) => {
        if (username === this.bot.username) return;
        this.bot.chat(`Hello ${username}, you said: ${message}`);
      });*/

      this.bot.on('error', err => {
        console.error(`Error: ${err.message}`);
      });

      this.bot.on('end', () => {
        console.info('Bot disconnected from server.');
      });
    });
  }

  public chat(msg: string): void {
    console.info(`(Bot) ${msg}`);
    this.bot.chat(msg);
  }

  addAction(action: Action): void {
    this.actionsQueue.push(action);
  }

  execute = (): void => {
    const processNext = async () => {
      if (this.actionsQueue.length === 0) {
        console.info('No more actions. Exiting.');
        return;  // Exit if the queue is empty
      }

      const action = this.actionsQueue[0];
      this.actionsQueue.splice(0, 1);
      console.info(`Executing ${action.name}`);

      if (action) {
        try {
          // Register all callbacks of the action
          this.registerOverriddenCallbacks(action);
          await action.execute().then(() => {
            console.debug("the action has succeeded...");
          }, (failedMessage) => {
            console.debug(`the action has failed: ${failedMessage}`);
          });
        } catch (error) {
          console.error(`Error executing action: ${error}. Continuing`);
        } finally {
          // De-register all callbacks of the action
          this.deregisterOverriddenCallbacks(action);
        }
      } else {
        console.info("Action was undefined.");
      }

      // Schedule the next execution asynchronously
      setImmediate(processNext);
    };

    // Start processing actions asynchronously
    processNext();
  };

  private registerOverriddenCallbacks(action: Action): void {
    for (const eventName of botEventNames) {
      const method = action[eventName];
      // Check if this method is implemented in the action, not inherited
      if (method && Object.getPrototypeOf(action).hasOwnProperty(eventName)) {
        console.debug(`Registering overridden callback: ${eventName}`);
        this.bot.on(eventName, method.bind(action));
      }
    }
  }

  private deregisterOverriddenCallbacks(action: Action): void {
    for (const eventName of botEventNames) {
      const method = action[eventName];
      if (method && Object.getPrototypeOf(action).hasOwnProperty(eventName)) {
        console.debug(`Deregistering overridden callback: ${eventName}`);
        this.bot.removeListener(eventName, method.bind(action));
      }
    }
  }
}


export abstract class Action extends EventEmitter implements BotEvents {

  public readonly name: string;
  private static idCounter = 0;
  private id: number = Action.idCounter++;
  protected manager: BotManager;
  constructor(_manager: BotManager) {
    super();
    this.name = this.constructor.name;
    this.manager = _manager;
  }

  chat(username: string, message: string, translate: string | null, jsonMsg: ChatMessage, matches: string[] | null): Promise<void> | void { }
  whisper(username: string, message: string, translate: string | null, jsonMsg: ChatMessage, matches: string[] | null): Promise<void> | void { }
  actionBar(jsonMsg: ChatMessage): Promise<void> | void { }
  error(err: Error): Promise<void> | void { }
  message(jsonMsg: ChatMessage, position: string): Promise<void> | void { }
  messagestr(message: string, position: string, jsonMsg: ChatMessage): Promise<void> | void { }
  unmatchedMessage(stringMsg: string, jsonMsg: ChatMessage): Promise<void> | void { }
  inject_allowed(): Promise<void> | void { }
  login(): Promise<void> | void { }
  spawn(): Promise<void> | void { }
  respawn(): Promise<void> | void { }
  game(): Promise<void> | void { }
  title(text: string): Promise<void> | void { }
  rain(): Promise<void> | void { }
  time(): Promise<void> | void { }
  kicked(reason: string, loggedIn: boolean): Promise<void> | void { }
  end(reason: string): Promise<void> | void { }
  spawnReset(): Promise<void> | void { }
  death(): Promise<void> | void { }
  health(): Promise<void> | void { }
  breath(): Promise<void> | void { }
  entitySwingArm(entity: Entity): Promise<void> | void { }
  entityHurt(entity: Entity): Promise<void> | void { }
  entityDead(entity: Entity): Promise<void> | void { }
  entityTaming(entity: Entity): Promise<void> | void { }
  entityTamed(entity: Entity): Promise<void> | void { }
  entityShakingOffWater(entity: Entity): Promise<void> | void { }
  entityEatingGrass(entity: Entity): Promise<void> | void { }
  entityHandSwap(entity: Entity): Promise<void> | void { }
  entityWake(entity: Entity): Promise<void> | void { }
  entityEat(entity: Entity): Promise<void> | void { }
  entityCriticalEffect(entity: Entity): Promise<void> | void { }
  entityMagicCriticalEffect(entity: Entity): Promise<void> | void { }
  entityCrouch(entity: Entity): Promise<void> | void { }
  entityUncrouch(entity: Entity): Promise<void> | void { }
  entityEquip(entity: Entity): Promise<void> | void { }
  entitySleep(entity: Entity): Promise<void> | void { }
  entitySpawn(entity: Entity): Promise<void> | void { }
  entityElytraFlew(entity: Entity): Promise<void> | void { }
  usedFirework(): Promise<void> | void { }
  itemDrop(entity: Entity): Promise<void> | void { }
  playerCollect(collector: Entity, collected: Entity): Promise<void> | void { }
  entityAttributes(entity: Entity): Promise<void> | void { }
  entityGone(entity: Entity): Promise<void> | void { }
  entityMoved(entity: Entity): Promise<void> | void { }
  entityDetach(entity: Entity, vehicle: Entity): Promise<void> | void { }
  entityAttach(entity: Entity, vehicle: Entity): Promise<void> | void { }
  entityUpdate(entity: Entity): Promise<void> | void { }
  entityEffect(entity: Entity, effect: Effect): Promise<void> | void { }
  entityEffectEnd(entity: Entity, effect: Effect): Promise<void> | void { }
  playerJoined(player: Player): Promise<void> | void { }
  playerUpdated(player: Player): Promise<void> | void { }
  playerLeft(entity: Player): Promise<void> | void { }
  blockUpdate(oldBlock: Block | null, newBlock: Block): Promise<void> | void { }
  'blockUpdate:(x, y, z)'(oldBlock: Block | null, newBlock: Block | null): Promise<void> | void { }
  chunkColumnLoad(entity: Vec3): Promise<void> | void { }
  chunkColumnUnload(entity: Vec3): Promise<void> | void { }
  soundEffectHeard(soundName: string, position: Vec3, volume: number, pitch: number): Promise<void> | void { }
  hardcodedSoundEffectHeard(soundId: number, soundCategory: number, position: Vec3, volume: number, pitch: number): Promise<void> | void { }
  noteHeard(block: Block, instrument: Instrument, pitch: number): Promise<void> | void { }
  pistonMove(block: Block, isPulling: number, direction: number): Promise<void> | void { }
  chestLidMove(block: Block, isOpen: number, block2: Block | null): Promise<void> | void { }
  blockBreakProgressObserved(block: Block, destroyStage: number): Promise<void> | void { }
  blockBreakProgressEnd(block: Block): Promise<void> | void { }
  diggingCompleted(block: Block): Promise<void> | void { }
  diggingAborted(block: Block): Promise<void> | void { }
  move(position: Vec3): Promise<void> | void { }
  forcedMove(): Promise<void> | void { }
  mount(): Promise<void> | void { }
  dismount(vehicle: Entity): Promise<void> | void { }
  windowOpen(window: Window): Promise<void> | void { }
  windowClose(window: Window): Promise<void> | void { }
  sleep(): Promise<void> | void { }
  wake(): Promise<void> | void { }
  experience(): Promise<void> | void { }
  physicsTick(): Promise<void> | void { }
  physicTick(): Promise<void> | void { }
  scoreboardCreated(scoreboard: ScoreBoard): Promise<void> | void { }
  scoreboardDeleted(scoreboard: ScoreBoard): Promise<void> | void { }
  scoreboardTitleChanged(scoreboard: ScoreBoard): Promise<void> | void { }
  scoreUpdated(scoreboard: ScoreBoard, item: number): Promise<void> | void { }
  scoreRemoved(scoreboard: ScoreBoard, item: number): Promise<void> | void { }
  scoreboardPosition(position: DisplaySlot, scoreboard: ScoreBoard): Promise<void> | void { }
  teamCreated(team: Team): Promise<void> | void { }
  teamRemoved(team: Team): Promise<void> | void { }
  teamUpdated(team: Team): Promise<void> | void { }
  teamMemberAdded(team: Team): Promise<void> | void { }
  teamMemberRemoved(team: Team): Promise<void> | void { }
  bossBarCreated(bossBar: BossBar): Promise<void> | void { }
  bossBarDeleted(bossBar: BossBar): Promise<void> | void { }
  bossBarUpdated(bossBar: BossBar): Promise<void> | void { }
  resourcePack(url: string, hash?: string, uuid?: string): Promise<void> | void { }
  particle(particle: Particle): Promise<void> | void { }
  goal_reached(goal: goals.Goal): void { }
  path_update(path: PartiallyComputedPath): void { }
  goal_updated(goal: goals.Goal, dynamic: boolean): void { }
  path_reset(reason: 'goal_updated' | 'movements_updated' | 'block_updated' | 'chunk_loaded' | 'goal_moved' | 'dig_error' | 'no_scaffolding_blocks' | 'place_error' | 'stuck'): void { }
  path_stop(): void { }

  // launch the logic of the task
  public abstract execute(): Promise<void>;

  protected complete(): void {
    console.debug(`Emitting complete_${this.id}`);
    this.emit(`complete_${this.id}`);
  }

  protected failed(reason?: string): void {
    this.emit(`failed_${this.id}`, reason);
  }

  public onceCompleted(listener: (...args: any[]) => void): void {
    this.once(`complete_${this.id}`, (...args: any[]) => {
      console.debug(`Recieved complete_${this.id}`);
      listener(args);
    });
  }

  public onceFailed(listener: (...args: any[]) => void): void {
    this.once(`failed_${this.id}`, () => (...args: any[]) => {
      console.debug(`recieved failed_${this.id}`);
      listener(args);
    });
  }

}


export type Context = Map<string, any>;
export type Label = string;
type Predicate = (context: Map<string, any>) => boolean;

export type ActionSequenceStep = {
  type: 'do' | 'doIf' | 'goto' | 'label' | 'switch' | 'wait' | 'exec';
  action?: Action;
  predicate?: Predicate;
  label?: Label;
  callback?: (context: Context) => Promise<void>;
  switchTarget?: ActionSequence,
  duration?: number,
}

export class ActionSequence {

  private static context: Context = new Map();
  //private static allSequences: Set<ActionSequence> = new Set();

  private sequence: Array<ActionSequenceStep> = new Array();
  private name: string;
  private onThrow: ActionSequence | undefined = undefined;

  public constructor(name: string, onThrow?: ActionSequence) {
    this.name = name;
    //ActionSequence.allSequences.set(this);
    this.onThrow = onThrow;
  }

  public static setVariable(key: string, value: any) {
    ActionSequence.context.set(key, value);
  }

  public static getVariable<T>(key: string, elseValue?: T): T {
    if (ActionSequence.context.has(key)) {
      return ActionSequence.context.get(key) as T;
    }
    return elseValue!;
  }

  public do(action: Action): ActionSequence {
    this.sequence.push({
      type: 'do',
      action
    });
    return this;
  }

  public label(label: Label): ActionSequence {
    this.sequence.push({
      type: 'label',
      label
    });
    return this;
  }

  public doIf(action: Action, predicate: Predicate): ActionSequence {
    this.sequence.push({
      type: 'doIf',
      action,
      predicate,
    });
    return this;
  }

  public goto(label: Label): ActionSequence {
    this.sequence.push({
      type: 'goto',
      label,
    });
    return this;
  }

  public switch(name: ActionSequence): ActionSequence {
    this.sequence.push({
      type: 'switch',
      switchTarget: name,
    });
    return this;
  }


  public wait(duration: number): ActionSequence {
    this.sequence.push({
      type: 'wait',
      duration,
    });
    return this;
  }

  public exec(callback: (context: Context) => Promise<void>): ActionSequence {
    this.sequence.push({
      type: 'wait',
      callback,
    });
    return this;
  }

  private findLabelStep(label: Label): number | undefined {
    const step = this.sequence.findIndex((element) => {
      if (element && element.label && element.label == label) {
        return element;
      }
    });
    return step
  }

  public static async execute(init: ActionSequence) {

    let currentSequence: ActionSequence = init;
    let i = 0;
    while (i != currentSequence.sequence.length) {

      const step = currentSequence.sequence[i];

      try {
        switch (step.type) {
          case 'do':
            await step.action!.execute(); // new Promise<void>((resolve) => step.action!.execute().finally(resolve));
            break;

          case 'doIf':
            if (step.predicate!(this.context)) {
              await step.action!.execute();
            }
            break;

          case 'goto':
            i = currentSequence.findLabelStep(step.label!)!;
            break;
          case 'wait':
            await new Promise<void>((resolve) => setTimeout(resolve, step.duration!));
            break;
          case 'switch':
            currentSequence = step.switchTarget!; //ActionSequence.allSequences.get(step.switchTarget!)!;
            i = 0;
            break;

          case 'exec':
            await step.callback!(ActionSequence.context);
            break;

          default:
            i++;
            break;
        }
      } catch (error) {
        console.error(`Error occured in execution: ${error}`);
        if (currentSequence.onThrow) {
          console.error(`Switching to ${currentSequence.onThrow.name}`);
          currentSequence = currentSequence.onThrow;
        }
      }

      if (step.type != 'goto' && step.type != 'switch') {
        i++;
      }
    }

  }


}