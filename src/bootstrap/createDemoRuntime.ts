import type { TaskSpec } from "../execution/Task";
import { ExecutionController } from "../execution/ExecutionController";
import { Executor } from "../execution/Executor";
import { ContainerSessionManager } from "../runtime/ContainerSessionManager";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { MineflayerWorldQueries } from "../world/MineflayerWorldQueries";
import { createCapabilityRegistry } from "./createCapabilities";

export interface RunningDemoRuntime {
  readonly controller: ExecutionController;
  shutdown(reason?: string): Promise<void>;
}

export function createDemoRuntime(
  runtime: MinecraftRuntime,
): RunningDemoRuntime {
  const world = new MineflayerWorldQueries(runtime);
  const sessions = new ContainerSessionManager(runtime.bot);
  const executor = new Executor({
    registry: createCapabilityRegistry(sessions),
    runtime,
    world,
  });
  const controller = new ExecutionController({ executor });
  controller.subscribe((event) => {
    if (event.type === "task_started") {
      console.info(`[${event.task.id}] Starting "${event.task.capability}".`);
    } else if (event.type === "task_finished") {
      console.info(
        `[${event.task.id}] "${event.task.capability}" finished:`,
        event.result,
      );
    } else if (event.type === "queue_idle") {
      console.info("Demo execution queue is idle.");
    }
  });

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
    const tasks: TaskSpec[] = [
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
      { capability: "dig", input: { position: target.position } },
    ];
    controller.enqueueMany(tasks);
    controller.resume();
  }

  return {
    controller,
    async shutdown(reason = "Demo runtime stopped."): Promise<void> {
      await controller.shutdown(reason);
      await sessions.closeActive(reason);
      runtime.disconnect(reason);
    },
  };
}
