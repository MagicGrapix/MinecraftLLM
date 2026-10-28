import "../../src/Logger";
import { WorldBuilder } from "../../src/devworld/WorldBuilder";
import { loadWorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { WorldBuilderCli } from "../../src/devworld/cli/WorldBuilderCli";
import {
  describeConnectionReason,
  MineflayerCommandTransport,
} from "../../src/devworld/controller/MineflayerCommandTransport";
import { WorldControllerRuntime } from "../../src/devworld/controller/WorldControllerRuntime";
import { CommandExecutor } from "../../src/devworld/execution/CommandExecutor";
import { SceneController } from "../../src/devworld/scenes/SceneController";

async function main(): Promise<void> {
  const config = loadWorldBuilderConfig();
  const runtime = new WorldControllerRuntime(config);
  let transport: MineflayerCommandTransport | null = null;
  let executor: CommandExecutor | null = null;
  let cli: WorldBuilderCli | null = null;
  let scenes: SceneController | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      cli?.close();
      scenes?.close();
      await executor?.shutdown(reason);
      transport?.close(reason);
      runtime.disconnect(reason);
    })();
    return shutdownPromise;
  };
  const signal = (): void => {
    void shutdown("World builder process stopped.");
  };

  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  try {
    console.info("Connecting world controller...");
    await runtime.connect();
    transport = new MineflayerCommandTransport(
      runtime.bot,
      config.commandResponseWindowMs,
    );
    await runtime.initialize(transport);
    console.info(
      `World controller "${config.controllerUsername}" is OP-verified and ready.`,
    );

    executor = new CommandExecutor({
      transport,
      commandsPerSecond: config.commandsPerSecond,
      maxQueueSize: config.maxQueueSize,
      maxPlanCommands: config.maxPlanCommands,
    });
    const builder = new WorldBuilder({ config });
    scenes = new SceneController(config, runtime, executor);
    cli = new WorldBuilderCli({
      runtime,
      builder,
      executor,
      commandsPerSecond: config.commandsPerSecond,
      scenes,
    });

    runtime.bot.once("end", () => {
      void shutdown("World controller connection ended.");
    });
    runtime.bot.once("kicked", (reason) => {
      void shutdown(
        `World controller kicked: ${describeConnectionReason(reason)}`,
      );
    });
    await cli.run();
  } finally {
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
    await shutdown("World builder quit.");
  }
}

void main().catch((error: unknown) => {
  console.error("World builder failed:", error);
  process.exitCode = 1;
});
