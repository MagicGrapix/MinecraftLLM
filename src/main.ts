import "./Logger";
import { DigCapability } from "./capabilities/Dig";
import { DropCapability } from "./capabilities/Drop";
import { EquipCapability } from "./capabilities/Equip";
import { GotoCapability } from "./capabilities/Goto";
import { PlaceCapability } from "./capabilities/Place";
import { CapabilityRegistry } from "./capabilities/CapabilityRegistry";
import { MINECRAFT_VERSION } from "./config";
import {
  ExecutionController,
  type ExecutionEvent,
} from "./execution/ExecutionController";
import { Executor } from "./execution/Executor";
import type { TaskSpec } from "./execution/Task";
import { MinecraftRuntime } from "./runtime/MinecraftRuntime";
import { MineflayerWorldQueries } from "./world/MineflayerWorldQueries";

async function main(): Promise<void> {
  const runtime = new MinecraftRuntime({
    host: process.env.MINECRAFT_HOST ?? "localhost",
    port: readPort(process.env.MINECRAFT_PORT),
    username: process.env.MINECRAFT_USERNAME ?? "bot",
    version: MINECRAFT_VERSION,
    auth: "offline",
  });
  let controller: ExecutionController | null = null;

  try {
    console.info("Connecting to Minecraft...");
    await runtime.connect();
    console.info(`Connected as ${runtime.bot.username}.`);

    const world = new MineflayerWorldQueries(runtime);
    const executor = new Executor({
      registry: createCapabilityRegistry(),
      runtime,
      world,
    });
    controller = new ExecutionController({ executor });
    controller.subscribe(logExecutionEvent);

    const targetNames = (
      process.env.DEMO_BLOCKS ?? "oak_log,birch_log,spruce_log"
    )
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const target = world.findNearestBlocks(targetNames, {
      maxDistance: 48,
      count: 1,
    })[0];

    if (!target) {
      console.warn(
        `No target block found within 48 blocks (${targetNames.join(", ")}).`,
      );
    } else {
      const taskSpecs: TaskSpec[] = [
        {
          capability: "goto",
          input: { position: target.position, range: 2 },
        },
        {
          capability: "equip",
          input: {
            item: process.env.DEMO_TOOL ?? "wooden_axe",
            destination: "hand",
          },
        },
        {
          capability: "dig",
          input: { position: target.position },
        },
      ];

      controller.enqueueMany(taskSpecs);
      const acknowledgement = controller.resume();
      console.info(
        `Execution resumed at revision ${acknowledgement.snapshot.revision}; control returned immediately.`,
      );
    }

    await waitForShutdown(runtime, controller);
  } finally {
    await controller?.shutdown("Minecraft harness stopped.");
    runtime.disconnect();
  }
}

function waitForShutdown(
  runtime: MinecraftRuntime,
  controller: ExecutionController,
): Promise<void> {
  console.info("Bot remains connected. Press Ctrl+C to stop.");

  return new Promise((resolve) => {
    let closing = false;

    const finish = (): void => {
      if (closing) return;
      closing = true;
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      runtime.bot.removeListener("end", finish);
      void controller
        .shutdown("Process shutdown requested.")
        .finally(resolve);
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    runtime.bot.once("end", finish);
  });
}

function createCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(new GotoCapability());
  registry.register(new DigCapability());
  registry.register(new EquipCapability());
  registry.register(new PlaceCapability());
  registry.register(new DropCapability());
  return registry;
}

function logExecutionEvent(event: ExecutionEvent): void {
  if (event.type === "task_started") {
    console.info(`[${event.task.id}] Starting "${event.task.capability}".`);
    return;
  }

  if (event.type === "task_finished") {
    if (event.result.ok) {
      console.info(
        `[${event.task.id}] "${event.task.capability}" succeeded:`,
        event.result.value,
      );
    } else {
      console.warn(
        `[${event.task.id}] "${event.task.capability}" failed:`,
        event.result.error,
      );
    }
    return;
  }

  if (event.type === "queue_idle") {
    console.info(
      `Execution queue is idle in "${event.snapshot.mode}" mode.`,
    );
  }
}

function readPort(value: string | undefined): number {
  if (value === undefined) return 25565;

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid MINECRAFT_PORT "${value}".`);
  }
  return port;
}

void main().catch((error: unknown) => {
  console.error("Executive layer failed to start:", error);
  process.exitCode = 1;
});
