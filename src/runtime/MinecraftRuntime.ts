import { createBot, type Bot, type BotOptions } from "mineflayer";
import { Movements, pathfinder } from "mineflayer-pathfinder";

export interface MinecraftRuntimeOptions {
  host: string;
  port: number;
  username: string;
  version?: string;
  auth?: BotOptions["auth"];
}

export class MinecraftRuntime {
  private botInstance: Bot | null = null;
  private connected = false;

  constructor(private readonly options: MinecraftRuntimeOptions) {}

  get bot(): Bot {
    if (!this.botInstance) {
      throw new Error("MinecraftRuntime is not connected.");
    }
    return this.botInstance;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.botInstance) {
      throw new Error("MinecraftRuntime.connect() can only be called once.");
    }

    const bot = createBot({
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      version: this.options.version,
      auth: this.options.auth,
    });

    this.botInstance = bot;
    bot.loadPlugin(pathfinder);

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        bot.removeListener("spawn", handleSpawn);
        bot.removeListener("error", handleError);
        bot.removeListener("end", handleEarlyEnd);
      };

      const handleSpawn = (): void => {
        cleanup();

        const movements = new Movements(bot);
        configureCapabilitySafeMovements(movements);
        bot.pathfinder.setMovements(movements);

        this.connected = true;
        resolve();
      };

      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const handleEarlyEnd = (reason: string): void => {
        cleanup();
        reject(new Error(`Minecraft connection ended before spawn: ${reason}`));
      };

      bot.once("spawn", handleSpawn);
      bot.once("error", handleError);
      bot.once("end", handleEarlyEnd);
    });

    bot.on("end", () => {
      this.connected = false;
    });
  }

  disconnect(reason = "Executive layer stopped."): void {
    if (!this.botInstance) return;

    this.connected = false;
    this.botInstance.quit(reason);
  }
}

export function configureCapabilitySafeMovements(
  movements: Pick<
    Movements,
    "canDig" | "allow1by1towers" | "scafoldingBlocks"
  >,
): void {
  // World mutations belong to explicit dig/place tasks, never to navigation.
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
}
