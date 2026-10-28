import { createBot, type Bot, type BotOptions } from "mineflayer";
import type { WorldBuilderConfig } from "../WorldBuilderConfig";
import { PHOTO_ACTOR } from "./ScenePlan";

/** A stationary photo subject: no runtime, chat listener, pathfinder or LLM. */
export class SceneActor {
  private instance: Bot | null = null;
  private closed = false;

  constructor(private readonly config: WorldBuilderConfig,
    private readonly create: (options: BotOptions) => Bot = createBot) {}

  get bot(): Bot | null { return this.instance; }

  async connect(players: Bot["players"]): Promise<void> {
    if (this.closed) throw new Error("Photo actor has been closed.");
    if (this.instance) return;
    if (Object.keys(players).some((name) => name.toLowerCase() === PHOTO_ACTOR)) {
      throw new Error(`${PHOTO_ACTOR} is already connected. Refusing to replace another session.`);
    }
    const bot = this.create({
      host: this.config.host, port: this.config.port, version: this.config.version,
      username: PHOTO_ACTOR, auth: "offline", physicsEnabled: false,
    });
    this.instance = bot;
    // Keep an error listener after spawn too; a disconnected actor must not crash the controller.
    bot.on("error", () => {
      if (this.instance === bot) this.instance = null;
      bot.quit("Photo actor connection failed.");
    });
    bot.once("end", () => { if (this.instance === bot) this.instance = null; });
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          bot.removeListener("spawn", spawned);
          bot.removeListener("error", failed);
          bot.removeListener("end", ended);
          bot.removeListener("kicked", kicked);
          if (error) reject(error); else resolve();
        };
        const spawned = () => finish();
        const failed = (error: Error) => finish(error);
        const ended = (reason: string) => finish(new Error(`Photo actor disconnected: ${reason}`));
        const kicked = (reason: unknown) => finish(new Error(`Photo actor kicked: ${String(reason)}`));
        const timer = setTimeout(() => finish(new Error("Photo actor connection timed out.")), 10_000);
        bot.once("spawn", spawned);
        bot.once("error", failed);
        bot.once("end", ended);
        bot.once("kicked", kicked);
      });
      if (this.closed || this.instance !== bot) throw new Error("Photo actor disconnected during setup.");
      if (!["overworld", "minecraft:overworld"].includes(bot.game.dimension)) {
        throw new Error("Photo actor must be in the overworld.");
      }
    } catch (error) {
      if (this.instance === bot) this.instance = null;
      bot.quit("Photo actor setup failed.");
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    const bot = this.instance;
    this.instance = null;
    bot?.quit("Photo controller stopped.");
  }
}
