import { randomUUID } from "node:crypto";
import { createBot, type Bot, type BotOptions } from "mineflayer";
import { Vec3 } from "vec3";
import { sleep } from "../../shared/helper";
import type { Position } from "../../shared/types";
import type { WorldBuilderConfig } from "../WorldBuilderConfig";
import { flatLayerProfile } from "../BlockCatalog";
import type {
  CommandTransport,
  TransportCommandResult,
} from "./MineflayerCommandTransport";

export interface FlatProfileObservation {
  readonly position: { readonly x: number; readonly z: number };
  readonly expected: readonly string[];
  readonly actual: readonly (string | null)[];
  readonly matches: boolean;
}

export class WorldControllerRuntime {
  private botInstance: Bot | null = null;
  private connected = false;
  private opVerified = false;
  private commandTransport: CommandTransport | null = null;

  constructor(
    private readonly config: WorldBuilderConfig,
    private readonly createControllerBot: (options: BotOptions) => Bot =
      createBot,
  ) {}

  get bot(): Bot {
    if (!this.botInstance) {
      throw new Error("WorldControllerRuntime is not connected.");
    }
    return this.botInstance;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get isOperatorVerified(): boolean {
    return this.opVerified;
  }

  async connect(): Promise<void> {
    if (this.botInstance) {
      throw new Error("WorldControllerRuntime.connect() can only run once.");
    }
    const bot = this.createControllerBot({
      host: this.config.host,
      port: this.config.port,
      username: this.config.controllerUsername,
      version: this.config.version,
      auth: "offline",
    });
    this.botInstance = bot;

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        bot.removeListener("spawn", spawn);
        bot.removeListener("error", error);
        bot.removeListener("end", ended);
      };
      const spawn = (): void => {
        cleanup();
        this.connected = true;
        resolve();
      };
      const error = (cause: Error): void => {
        cleanup();
        reject(cause);
      };
      const ended = (reason: string): void => {
        cleanup();
        reject(
          new Error(
            `World controller connection ended before spawn: ${reason}`,
          ),
        );
      };
      bot.once("spawn", spawn);
      bot.once("error", error);
      bot.once("end", ended);
    });

    bot.on("end", () => {
      this.connected = false;
      this.opVerified = false;
      this.commandTransport = null;
    });
    if (!isOverworld(bot.game.dimension)) {
      throw new Error(
        `World controller must be in the overworld, got "${bot.game.dimension}".`,
      );
    }
  }

  async initialize(transport: CommandTransport): Promise<void> {
    const marker = `WB_OP_${randomUUID().replace(/-/g, "")}`;
    const probe = await transport.send(
      `execute if entity @s run tellraw @s {"text":"${marker}"}`,
    );
    if (!probe.responses.some((response) => response.includes(marker))) {
      throw new Error(
        `Operator probe failed. Run "op ${this.config.controllerUsername}" in the server console.`,
      );
    }
    this.opVerified = true;

    const centerX = Math.floor(
      (this.config.arena.min.x + this.config.arena.max.x) / 2,
    );
    const centerZ = Math.floor(
      (this.config.arena.min.z + this.config.arena.max.z) / 2,
    );
    const spectator = await transport.send(
      `gamemode spectator ${this.config.controllerUsername}`,
    );
    if (spectator.error) throw new Error(spectator.error);
    const parked = await transport.send(
      `tp ${this.config.controllerUsername} ${centerX} ${this.config.controllerParkY} ${centerZ}`,
    );
    if (parked.error) throw new Error(parked.error);
    await this.waitForArenaChunks(5_000);
    this.commandTransport = transport;
  }

  async clearAgentInventory(): Promise<TransportCommandResult> {
    if (!this.connected || !this.opVerified || !this.commandTransport) {
      throw new Error("World controller is not ready for admin commands.");
    }
    if (!this.getAgentPosition()) {
      throw new Error(
        "The configured agent player is not connected in the overworld.",
      );
    }
    if (!/^[A-Za-z0-9_]{1,16}$/.test(this.config.agentUsername)) {
      throw new Error("Configured agent username is not a valid command target.");
    }
    const result = await this.commandTransport.send(`clear ${this.config.agentUsername}`);
    if (result.error) throw new Error(result.error);
    return result;
  }

  getAgentPosition(): Position | null {
    const entity = this.bot.players[this.config.agentUsername]?.entity;
    if (!entity) return null;
    return {
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
    };
  }

  readFlatProfile(): FlatProfileObservation {
    const profile = flatLayerProfile(this.config.surfaceY);
    const x = Math.floor(
      (this.config.arena.min.x + this.config.arena.max.x) / 2,
    );
    const z = Math.floor(
      (this.config.arena.min.z + this.config.arena.max.z) / 2,
    );
    const ys = [
      profile.bedrockY,
      profile.lowerDirtY,
      profile.upperDirtY,
      profile.grassY,
      profile.airY,
    ];
    const expected = [
      "bedrock",
      "dirt",
      "dirt",
      "grass_block",
      "air",
    ];
    const actual = ys.map(
      (y) => this.bot.blockAt(new Vec3(x, y, z))?.name ?? null,
    );
    return {
      position: { x, z },
      expected,
      actual,
      matches: expected.every(
        (blockName, index) => actual[index] === blockName,
      ),
    };
  }

  disconnect(reason = "World builder stopped."): void {
    if (!this.botInstance) return;
    this.connected = false;
    this.opVerified = false;
    this.commandTransport = null;
    this.botInstance.quit(reason);
  }

  private async waitForArenaChunks(timeoutMs: number): Promise<void> {
    const points = [
      this.config.arena.min,
      this.config.arena.max,
      {
        x: this.config.arena.min.x,
        y: this.config.surfaceY,
        z: this.config.arena.max.z,
      },
      {
        x: this.config.arena.max.x,
        y: this.config.surfaceY,
        z: this.config.arena.min.z,
      },
    ];
    const deadline = Date.now() + timeoutMs;
    while (
      points.some(
        (point) =>
          this.bot.world.getColumnAt(
            new Vec3(point.x, this.config.surfaceY, point.z),
          ) == null,
      )
    ) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for all arena chunks to load.",
        );
      }
      await sleep(50);
    }
  }
}

function isOverworld(dimension: string): boolean {
  return dimension === "overworld" || dimension === "minecraft:overworld";
}
