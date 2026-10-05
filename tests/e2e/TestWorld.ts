import { WorldBuilder } from "../../src/devworld/WorldBuilder";
import { WorldPlanFactory, type WorldPlan } from "../../src/devworld/WorldPlan";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { WorldControllerRuntime } from "../../src/devworld/controller/WorldControllerRuntime";
import { MineflayerCommandTransport } from "../../src/devworld/controller/MineflayerCommandTransport";
import { CommandExecutor } from "../../src/devworld/execution/CommandExecutor";
import { containsPosition, createArenaBounds } from "../../src/devworld/ArenaBounds";
import { bounded, until, message } from "./async";
import { firstTerrainMismatch, formatTerrainMismatch, type ExpectedBlock, type TerrainMismatch } from "./TerrainVerification";
import type { ContainerObservation, Observation, Scenario } from "./types";
import { Vec3 } from "vec3";
import { BlockNbtReader, chestInventory, NbtObservationError } from "./BlockNbtReader";
import { environmentPlan, environmentReady, observeDrops } from "./EnvironmentObservations";

export class TestWorld {
  private readonly runtime: WorldControllerRuntime;
  private transport: MineflayerCommandTransport | null = null;
  private executor: CommandExecutor | null = null;
  private failure: string | null = null;
  private nbt: BlockNbtReader | null = null;
  constructor(readonly config: WorldBuilderConfig, private readonly record: (event: string, data: unknown) => void) {
    this.runtime = new WorldControllerRuntime(config);
  }
  async connect(): Promise<void> {
    await bounded(this.runtime.connect(), 20_000, "World controller connection");
    this.runtime.bot.on("error", (error) => { this.failure = error.message; });
    this.runtime.bot.on("end", () => { this.failure ??= "World controller disconnected."; });
    this.runtime.bot.on("death", () => { this.failure ??= "World controller died; terrain observations are no longer reliable."; });
    this.transport = new MineflayerCommandTransport(this.runtime.bot, this.config.commandResponseWindowMs);
    await this.runtime.initialize(this.transport);
    this.nbt = new BlockNbtReader(this.runtime.bot._client);
    this.executor = new CommandExecutor({ ...this.config, transport: this.transport });
    if (this.runtime.bot.players[this.config.agentUsername]) throw new Error(`Player ${this.config.agentUsername} is already online. Stop that test bot first.`);
  }
  assertHealthy(): void { if (this.failure) throw new Error(this.failure); }
  inArena(position: Observation["position"]): boolean { return containsPosition(this.config.arena, position); }

  async prepareTerrain(scenario: Scenario, signal?: AbortSignal): Promise<void> {
    await this.execute(new WorldBuilder({ config: this.config }).resetTerrain(), signal);
    // Verify every cell: a missing chunk is unknown, never interpreted as air.
    await this.verifyTerrain([], "Superflat reset verification", signal);
    if (scenario.fixture) await this.execute(scenario.fixture(this.config), signal);
    await this.verifyTerrain(scenario.expectedBlocks?.(this.config) ?? [], "Scenario fixture verification", signal);
    // Entity fixtures are added only after the strict entity-free terrain check.
    const containers = scenario.containers?.(this.config) ?? [];
    const drops = scenario.drops?.(this.config) ?? [];
    const extras = environmentPlan(this.config, containers, drops);
    if (extras) await this.execute(extras, signal);
    if (containers.length || drops.length) {
      let observed: Pick<Observation, "containers" | "drops"> = {};
      try {
        await until(async () => {
          observed = await this.observeEnvironment(scenario);
          return environmentReady(observed, containers, drops);
        }, 10_000, "Scenario chest/drop verification", signal, () => `Last observed: ${JSON.stringify(observed)}`);
      } catch (error) {
        this.record("world.environment_verification_failed", { error: message(error), observed });
        throw error;
      }
    }
  }

  async observeEnvironment(scenario: Scenario): Promise<Pick<Observation, "containers" | "drops">> {
    this.assertHealthy();
    const result: Pick<Observation, "containers" | "drops"> = {};
    if (scenario.containers) {
      if (!this.nbt) throw new Error("Controller NBT observer is not ready.");
      const containers: ContainerObservation[] = [];
      for (const { position } of scenario.containers(this.config)) {
        const block = this.runtime.bot.blockAt(new Vec3(position.x, position.y, position.z));
        if (block?.name !== "chest") {
          containers.push({ position, inventory: null, error: {
            code: block ? "BLOCK_NOT_CHEST" : "BLOCK_UNAVAILABLE",
            message: `Expected chest; observed ${block?.name ?? "unloaded cell"}.`,
          } });
          continue;
        }
        try {
          const raw = await this.nbt.read(position);
          const current = this.runtime.bot.blockAt(new Vec3(position.x, position.y, position.z));
          if (current?.name !== "chest") {
            containers.push({ position, inventory: null, error: { code: "BLOCK_CHANGED", message: "Chest disappeared or became unobservable during NBT query." } });
            continue;
          }
          const parsed = chestInventory(raw, current.name);
          containers.push(parsed.ok ? { position, inventory: parsed.inventory }
            : { position, inventory: null, error: parsed.error });
        } catch (error) {
          containers.push({ position, inventory: null, error: {
            code: error instanceof NbtObservationError ? error.code : "NBT_QUERY_FAILED", message: message(error),
          } });
        }
      }
      result.containers = containers;
    }
    if (scenario.drops) result.drops = observeDrops(this.runtime.bot, this.config);
    return result;
  }

  async preparePlayer(scenario: Scenario, snapshot: () => Promise<Observation>, signal?: AbortSignal): Promise<Observation> {
    if (scenario.hungry && this.runtime.bot.game.difficulty === "peaceful") {
      throw new Error("eat_food requires easy, normal or hard difficulty; the test does not change server difficulty.");
    }
    const username = this.config.agentUsername;
    await until(() => !!this.runtime.bot.players[username], 10_000, "Player visible to controller", signal);
    const y = this.config.surfaceY + 1;
    const p = { x: 0, y, z: 0 };
    const commands = [
      `clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`,
      `tp ${username} 0.5 ${y} 0.5 0 0`,
      `effect give ${username} minecraft:instant_health 1 10 true`,
      `effect give ${username} minecraft:saturation 1 10 true`,
      `experience set ${username} 0 levels`, `experience set ${username} 0 points`,
      "time set day", "weather clear",
      ...Object.entries(scenario.initialInventory).map(([item, count]) => {
        if (!/^[a-z0-9_]+$/.test(item) || !Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error("Invalid scenario inventory item/count.");
        return `give ${username} minecraft:${item} ${count}`;
      }),
      `effect clear ${username}`,
      // Four seconds drain saturation and some food; wait for expiry before arming.
      ...(scenario.hungry ? [`effect give ${username} minecraft:hunger 4 255 true`] : []),
    ];
    await this.execute(new WorldPlanFactory(this.config).create("Prepare test player", commands.map((text) => ({
      text, estimatedBlocksChanged: 0, affectedBounds: createArenaBounds(p, p),
    }))), signal);
    let observed: Observation | undefined;
    await until(async () => {
      observed = await snapshot();
      return playerReady(observed, scenario, y)
        && environmentReady(observed, scenario.containers?.(this.config) ?? [], scenario.drops?.(this.config) ?? []);
    }, 10_000, "Initial player state verification", signal, () => JSON.stringify({
      food: observed?.food, effects: observed?.effects, health: observed?.health, inventory: observed?.inventory,
      position: observed?.position, containers: observed?.containers, drops: observed?.drops,
    }));
    return observed!;
  }

  async chat(text: string): Promise<void> {
    this.assertHealthy();
    if (!text.trim() || text.length > 220 || /[\r\n\u0000]/.test(text) || text.startsWith("/")) throw new Error("Scenario chat must be one plain message of at most 220 characters.");
    // World setup uses the same sender's spam budget. Leave a full interval after its last command.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    this.runtime.bot.chat(text);
    this.record("controller.chat", { text });
  }

  async waitDisconnected(): Promise<void> {
    await until(() => { this.assertHealthy(); return !this.runtime.bot.players[this.config.agentUsername]; }, 10_000, "Server-confirmed test bot disconnect");
  }
  async close(): Promise<void> {
    try { await this.executor?.shutdown(); }
    finally { this.transport?.close(); this.runtime.disconnect(); }
  }
  private async execute(plan: WorldPlan, signal?: AbortSignal): Promise<void> {
    this.assertHealthy();
    if (!this.executor) throw new Error("Controller is not ready.");
    const stop = () => this.executor!.stop("Campaign cancelled.");
    signal?.throwIfAborted();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const result = await this.executor.execute(plan);
      this.record("world.plan", result);
      if (result.status !== "completed") throw new Error(result.error ?? "World preparation failed.");
    } finally { signal?.removeEventListener("abort", stop); }
  }
  private async verifyTerrain(blocks: readonly ExpectedBlock[], label: string, signal?: AbortSignal): Promise<void> {
    let mismatch: TerrainMismatch | null = null;
    try {
      await until(() => {
        this.assertHealthy();
        mismatch = firstTerrainMismatch(this.runtime.bot, this.config, blocks);
        return mismatch === null;
      }, 10_000, label, signal, () => mismatch ? formatTerrainMismatch(mismatch) : "");
    } catch (error) {
      if (!signal?.aborted) {
        const bot = this.runtime.bot;
        this.record("world.verification_failed", {
          label, error: message(error), firstMismatch: mismatch,
          controller: {
            position: bot.entity?.position
              ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
            health: bot.health, gameMode: bot.game.gameMode,
          },
        });
      }
      throw error;
    }
  }
}

export function playerReady(observed: Observation, scenario: Scenario, y: number): boolean {
  const actual = Object.entries(observed.inventory).filter(([, n]) => n > 0).sort();
  const expected = Object.entries(scenario.initialInventory).sort();
  return JSON.stringify(actual) === JSON.stringify(expected) && observed.physicalIdle && observed.mode === "idle" && !observed.windowOpen
    && observed.blocks.every((block) => block.name !== null)
    && (observed.containers ?? []).every((container) => container.inventory !== null)
    && observed.health === 20 && (scenario.hungry ? observed.food >= 6 && observed.food <= 16 : observed.food === 20)
    && observed.effects === 0 && observed.onGround
    && Math.abs(observed.position.x - 0.5) < 0.05 && Math.abs(observed.position.y - y) < 0.05 && Math.abs(observed.position.z - 0.5) < 0.05
    && Math.abs(observed.pitch) < 0.01 && Math.abs(Math.abs(observed.yaw) - Math.PI) < 0.01;
}
