import { sleep } from "../../shared/helper";
import type { WorldBuilderConfig } from "../WorldBuilderConfig";
import type { WorldControllerRuntime } from "../controller/WorldControllerRuntime";
import type { CommandExecutor } from "../execution/CommandExecutor";
import { SceneActor } from "./SceneActor";
import { getScene } from "./SceneCatalog";
import { createScenePlan, type PreparedScene } from "./ScenePlan";
import { sceneMismatch } from "./SceneVerification";

export class SceneController {
  private closed = false;

  constructor(private readonly config: WorldBuilderConfig,
    private readonly runtime: WorldControllerRuntime,
    private readonly executor: CommandExecutor,
    private readonly actor = new SceneActor(config)) {}

  prepare(id: number): PreparedScene { return createScenePlan(this.config, getScene(id)); }

  async apply(prepared: PreparedScene): Promise<void> {
    this.requireReady();
    await this.actor.connect(this.runtime.bot.players);
    this.requireReady();
    const result = await this.executor.execute(prepared.plan);
    if (result.status !== "completed") {
      throw new Error(`Scene ${result.status}: ${result.error ?? "command execution failed"}. Changes already made are not rolled back.`);
    }
    const deadline = Date.now() + 5_000;
    let stable = 0;
    while (true) {
      this.requireReady();
      const mismatch = sceneMismatch(prepared, this.runtime.bot, this.actor.bot);
      stable = mismatch ? 0 : stable + 1;
      if (stable >= 2) return;
      if (Date.now() >= deadline) throw new Error(`Scene verification timed out: ${mismatch ?? "observations not stable yet"} No automatic retry or rollback.`);
      await sleep(100);
    }
  }

  close(): void {
    this.closed = true;
    this.actor.close();
  }

  private requireReady(): void {
    if (this.closed || !this.runtime.isConnected || !this.runtime.isOperatorVerified) {
      throw new Error("Photo scenes require the connected, OP-verified World Controller.");
    }
    if (Object.keys(this.runtime.bot.players).some((name) => name.toLowerCase() === this.config.agentUsername.toLowerCase())) {
      throw new Error(`Stop/disconnect the regular agent (${this.config.agentUsername}) before staging a scene. No automatic stop is performed.`);
    }
  }
}
