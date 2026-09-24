import type { TaskSpec } from "../execution/Task";
import { SequentialPlanRunner } from "../execution/SequentialPlanRunner";
import { Executor } from "../execution/Executor";
import { ContainerSessionManager } from "../runtime/ContainerSessionManager";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { MineflayerWorldQueries } from "../world/MineflayerWorldQueries";
import { createCapabilityRegistry } from "./createCapabilities";

export interface RunningDemoRuntime {
  readonly runner: SequentialPlanRunner;
  shutdown(reason?: string): Promise<void>;
}

export function createDemoRuntime(
  runtime: MinecraftRuntime,
): RunningDemoRuntime {
  const world = new MineflayerWorldQueries(runtime);
  const sessions = new ContainerSessionManager(runtime.bot);
  const runner = new SequentialPlanRunner(
    new Executor({
      registry: createCapabilityRegistry(sessions),
      runtime,
      world,
    }),
  );
  runner.subscribe((event) => {
    if (event.type === "task_started") {
      console.info(`[${event.task.id}] Starting "${event.task.capability}".`);
    } else {
      console.info(
        `[${event.task.id}] "${event.task.capability}" finished:`,
        event.result,
      );
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
  let demoPromise = Promise.resolve();
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
    runner.setPlan(tasks);
    demoPromise = runDemoPlan(runner);
  }

  return {
    runner,
    async shutdown(reason = "Demo runtime stopped."): Promise<void> {
      await runner.shutdown(reason);
      await demoPromise.catch(() => undefined);
      await sessions.closeActive(reason);
      runtime.disconnect(reason);
    },
  };
}

async function runDemoPlan(runner: SequentialPlanRunner): Promise<void> {
  while (runner.remaining().length > 0) {
    await runner.executeNext();
  }
  console.info("Demo sequential plan is complete.");
}
