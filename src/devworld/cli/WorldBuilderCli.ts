import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Position } from "../../shared/types";
import type { WorldBuilder } from "../WorldBuilder";
import type { WorldControllerRuntime } from "../controller/WorldControllerRuntime";
import type { CommandExecutor } from "../execution/CommandExecutor";
import type { WorldPlan } from "../WorldPlan";
import type { SceneController } from "../scenes/SceneController";
import { SCENES } from "../scenes/SceneCatalog";
import { PHOTO_ACTOR, xyz, type PreparedScene } from "../scenes/ScenePlan";
import {
  parseWorldCommand,
  type GenerativeWorldCommand,
  type WorldCliCommand,
} from "./parseWorldCommand";

export interface WorldBuilderCliOptions {
  readonly runtime: WorldControllerRuntime;
  readonly builder: WorldBuilder;
  readonly executor: CommandExecutor;
  readonly commandsPerSecond: number;
  readonly scenes?: Pick<SceneController, "prepare" | "apply">;
  readonly readline?: Pick<ReadlineInterface, "question" | "close">;
  readonly writeLine?: (message: string) => void;
}

export class WorldBuilderCli {
  private readonly readline: Pick<
    ReadlineInterface,
    "question" | "close"
  >;
  private readonly writeLine: (message: string) => void;
  private closed = false;

  constructor(private readonly options: WorldBuilderCliOptions) {
    this.readline =
      options.readline ?? createInterface({ input, output });
    this.writeLine = options.writeLine ?? console.info;
  }

  async run(): Promise<void> {
    this.printHelp();
    while (!this.closed) {
      let line: string;
      try {
        line = await this.readline.question("> ");
      } catch {
        break;
      }
      try {
        const action = await this.executeLine(line);
        if (action === "quit") break;
      } catch (error: unknown) {
        this.writeLine(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.close();
  }

  async executeLine(
    line: string,
  ): Promise<"continue" | "quit"> {
    const command = parseWorldCommand(line);
    switch (command.kind) {
      case "help":
        this.printHelp();
        return "continue";
      case "status":
        this.printStatus();
        return "continue";
      case "quit":
        return "quit";
      case "clear":
        await this.executePlan(this.options.builder.clear());
        return "continue";
      case "clear_inventory": {
        this.requireAgentPosition();
        const result = await this.options.runtime.clearAgentInventory();
        this.writeLine(
          `Sent /${result.command}. This command deletes items rather than dropping them.`,
        );
        for (const response of result.responses) {
          this.writeLine(`  ${response}`);
        }
        return "continue";
      }
      case "reset":
        this.requireAgentPosition();
        this.warnAboutFlatProfile();
        await this.executePlan(this.options.builder.reset());
        return "continue";
      case "preview":
        if (command.command.kind === "scene") {
          const scene = this.requireScenes().prepare(command.command.id);
          this.previewPlan(scene.plan);
          this.printSceneDetails(scene);
          return "continue";
        }
        this.previewPlan(
          this.generateRelativePlan(command.command),
        );
        return "continue";
      case "scene_list":
        for (const scene of SCENES) this.writeLine(`${scene.id}. ${scene.name}: ${scene.description}`);
        this.writeLine("scene <id> replaces the photo stage and resets bot's inventory, position and game mode; disconnect the regular agent first. Staged illustrations, not autonomous runs.");
        return "continue";
      case "scene": {
        const scenes = this.requireScenes();
        const scene = scenes.prepare(command.id);
        this.writeLine("Warning: blocks and non-player entities inside the photo stage will be replaced. Time/weather change globally. No rollback.");
        this.printPlan(scene.plan, false);
        this.writeLine(`Preparing ${PHOTO_ACTOR} and sending commands at up to ${this.options.commandsPerSecond}/second...`);
        await scenes.apply(scene);
        this.writeLine(`Scene ${scene.scene.id} ready: decor, actor position, held item and loose items verified. No LLM called.`);
        this.printSceneDetails(scene);
        return "continue";
      }
      case "tree":
      case "forest":
      case "ore":
        await this.executePlan(this.generateRelativePlan(command));
        return "continue";
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readline.close();
  }

  private generateRelativePlan(
    command: GenerativeWorldCommand,
  ): WorldPlan {
    const center = this.requireAgentPosition();
    if (command.kind === "tree") {
      return this.options.builder.addTree(center, command.radius);
    }
    if (command.kind === "forest") {
      return this.options.builder.addForest(
        center,
        command.trees,
        command.radius,
      );
    }
    return this.options.builder.addOre(
      center,
      command.ore,
      command.size,
    );
  }

  private requireScenes(): NonNullable<WorldBuilderCliOptions["scenes"]> {
    if (!this.options.scenes) throw new Error("Photo scenes are not configured in this controller.");
    return this.options.scenes;
  }

  private printSceneDetails(scene: PreparedScene): void {
    const { camera } = scene;
    this.writeLine(`Staged illustration: ${scene.scene.description}`);
    this.writeLine(`Optional camera command (run as your player, not in this terminal): /tp @s ${xyz(camera.position)} ${camera.yaw} ${camera.pitch}`);
    this.writeLine("Keep this terminal open for bot to remain connected. Capture manually in Minecraft.");
    if (scene.scene.drawing) this.writeLine(`Matching blueprint (bottom to top; A=oak_planks, .=air):\n${scene.scene.drawing}`);
  }

  private requireAgentPosition(): Position {
    const position = this.options.runtime.getAgentPosition();
    if (!position) {
      throw new Error(
        "The configured agent player is not connected in the overworld.",
      );
    }
    return position;
  }

  private warnAboutFlatProfile(): void {
    const observation = this.options.runtime.readFlatProfile();
    if (!observation.matches) {
      this.writeLine(
        `Warning: flat profile differs at ${observation.position.x},${observation.position.z}. ` +
          `Expected ${observation.expected.join("/")} but observed ${observation.actual.join("/")}.`,
      );
    }
  }

  private previewPlan(plan: WorldPlan): void {
    this.printPlan(plan, true);
    this.writeLine("Preview only; no command sent.");
  }

  private async executePlan(plan: WorldPlan): Promise<void> {
    this.printPlan(plan, false);
    this.writeLine(
      `Executing at up to ${this.options.commandsPerSecond} commands/second...`,
    );
    const result = await this.options.executor.execute(plan);
    if (result.status === "completed") {
      this.writeLine(
        `Plan sent; ${result.commandsSent} commands. No refusal observed; world changes are not independently verified.`,
      );
    } else {
      this.writeLine(
        `Plan ${result.status}: ${result.error ?? "unknown error"}`,
      );
    }
  }

  private printPlan(plan: WorldPlan, includeCommands: boolean): void {
    this.writeLine(`Generated plan: ${plan.description}`);
    this.writeLine(`Commands: ${plan.commands.length}`);
    this.writeLine(
      `Estimated blocks changed: ${plan.estimatedBlocksChanged}`,
    );
    this.writeLine(`Affected bounds: ${formatBounds(plan)}`);
    if (includeCommands) {
      for (const command of plan.commands) {
        this.writeLine(`  /${command.text}`);
      }
    }
  }

  private printStatus(): void {
    const executor = this.options.executor.snapshot();
    const agent = this.options.runtime.getAgentPosition();
    this.writeLine(
      [
        `connected=${this.options.runtime.isConnected}`,
        `opVerified=${this.options.runtime.isOperatorVerified}`,
        `dimension=${
          this.options.runtime.isConnected
            ? this.options.runtime.bot.game.dimension
            : "disconnected"
        }`,
        `agent=${agent ? `${agent.x},${agent.y},${agent.z}` : "offline"}`,
        `activePlan=${executor.activePlanId ?? "none"}`,
        `pendingPlans=${executor.pendingPlans}`,
        `reservedCommands=${executor.reservedCommands}`,
      ].join(" "),
    );
  }

  private printHelp(): void {
    this.writeLine(
      [
        "Commands:",
        "  help",
        "  status",
        "  tree [radius]",
        "  forest <trees> <radius>",
        "  ore <iron|coal> <size>",
        "  clear",
        "  inventory clear all  (permanently delete the agent's items)",
        "  reset",
        "  preview tree [radius]",
        "  preview forest <trees> <radius>",
        "  preview ore <iron|coal> <size>",
        "  scene list",
        "  scene <id>  (replaces photo stage and resets bot's inventory/position/game mode; disconnect the regular agent)",
        "  preview scene <id>",
        "  quit",
      ].join("\n"),
    );
  }
}

function formatBounds(plan: WorldPlan): string {
  const { min, max } = plan.affectedBounds;
  return `(${min.x},${min.y},${min.z}) -> (${max.x},${max.y},${max.z})`;
}
