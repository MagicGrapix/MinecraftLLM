import assert from "node:assert/strict";
import test from "node:test";
import { WorldBuilder } from "../../../src/devworld/WorldBuilder";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import type { RandomSource } from "../../../src/devworld/RandomSource";
import { WorldBuilderCli } from "../../../src/devworld/cli/WorldBuilderCli";
import {
  WorldCommandParseError,
  parseWorldCommand,
} from "../../../src/devworld/cli/parseWorldCommand";
import type { WorldControllerRuntime } from "../../../src/devworld/controller/WorldControllerRuntime";
import type { CommandExecutor } from "../../../src/devworld/execution/CommandExecutor";
import type { WorldPlan } from "../../../src/devworld/WorldPlan";

test("terminal parser accepts the command grammar strictly", () => {
  assert.deepEqual(parseWorldCommand("tree"), { kind: "tree" });
  assert.deepEqual(parseWorldCommand("tree 10"), {
    kind: "tree",
    radius: 10,
  });
  assert.deepEqual(parseWorldCommand("forest 10 25"), {
    kind: "forest",
    trees: 10,
    radius: 25,
  });
  assert.deepEqual(parseWorldCommand("preview ore iron 8"), {
    kind: "preview",
    command: { kind: "ore", ore: "iron", size: 8 },
  });
  assert.deepEqual(parseWorldCommand("inventory clear all"), {
    kind: "clear_inventory",
  });
});

test("terminal parser rejects invalid and unsafe forms", () => {
  assert.throws(
    () => parseWorldCommand("attends"),
    WorldCommandParseError,
  );
  assert.throws(
    () => parseWorldCommand("preview reset"),
    /supports only/,
  );
  assert.throws(
    () => parseWorldCommand("ore diamond 2"),
    /iron.*coal/,
  );
  assert.throws(() => parseWorldCommand("inventory clear"), /Usage/);
  assert.throws(() => parseWorldCommand("inventory clear all bot"), /Usage/);
});

test("preview generates a plan without invoking the executor", async () => {
  const config = loadWorldBuilderConfig({});
  const builder = new WorldBuilder({
    config,
    random: new LcgRandom(42),
    createId: () => "preview-plan",
  });
  let executions = 0;
  const output: string[] = [];
  const executor = {
    execute: async (_plan: WorldPlan) => {
      executions += 1;
      throw new Error("preview must not execute");
    },
    snapshot: () => ({
      stopped: false,
      activePlanId: null,
      pendingPlans: 0,
      reservedCommands: 0,
    }),
  } as unknown as CommandExecutor;
  const runtime = {
    isConnected: true,
    isOperatorVerified: true,
    getAgentPosition: () => ({ x: 0, y: -60, z: 0 }),
    readFlatProfile: () => ({
      position: { x: 0, z: 0 },
      expected: [],
      actual: [],
      matches: true,
    }),
    bot: { game: { dimension: "overworld" } },
  } as unknown as WorldControllerRuntime;
  const cli = new WorldBuilderCli({
    runtime,
    builder,
    executor,
    commandsPerSecond: 8,
    readline: {
      question: async () => "",
      close: () => undefined,
    },
    writeLine: (line) => output.push(line),
  });

  await cli.executeLine("preview ore iron 8");

  assert.equal(executions, 0);
  assert.equal(
    output.some((line) => line === "Preview only; no command sent."),
    true,
  );
  assert.equal(
    output.some((line) => line.includes("minecraft:iron_ore")),
    true,
  );
});

test("relative commands and reset refuse an absent agent but clear remains available", async () => {
  const config = loadWorldBuilderConfig({});
  const builder = new WorldBuilder({
    config,
    random: new LcgRandom(42),
  });
  let executions = 0;
  const executor = {
    execute: async (plan: WorldPlan) => {
      executions += 1;
      return {
        planId: plan.id,
        description: plan.description,
        status: "completed",
        startedAt: 0,
        finishedAt: 1,
        commandsSent: plan.commands.length,
        records: [],
      };
    },
    snapshot: () => ({
      stopped: false,
      activePlanId: null,
      pendingPlans: 0,
      reservedCommands: 0,
    }),
  } as unknown as CommandExecutor;
  const runtime = {
    isConnected: true,
    isOperatorVerified: true,
    getAgentPosition: () => null,
    bot: { game: { dimension: "overworld" } },
  } as unknown as WorldControllerRuntime;
  const cli = new WorldBuilderCli({
    runtime,
    builder,
    executor,
    commandsPerSecond: 8,
    readline: {
      question: async () => "",
      close: () => undefined,
    },
    writeLine: () => undefined,
  });

  await assert.rejects(cli.executeLine("tree"), /not connected/);
  await assert.rejects(cli.executeLine("reset"), /not connected/);
  await assert.rejects(cli.executeLine("inventory clear all"), /not connected/);
  await cli.executeLine("clear");
  assert.equal(executions, 1);
});

test("inventory clear all uses the controller without changing the world", async () => {
  const config = loadWorldBuilderConfig({});
  const output: string[] = [];
  let adminCalls = 0;
  let worldPlans = 0;
  const runtime = {
    getAgentPosition: () => ({ x: 0, y: -60, z: 0 }),
    clearAgentInventory: async () => {
      adminCalls += 1;
      return {
        command: "clear bot",
        sentAt: 0,
        responses: ["Removed 4 items from bot"],
      };
    },
  } as unknown as WorldControllerRuntime;
  const executor = {
    execute: async () => {
      worldPlans += 1;
      throw new Error("No world plan should execute.");
    },
  } as unknown as CommandExecutor;
  const cli = new WorldBuilderCli({
    runtime,
    builder: new WorldBuilder({ config }),
    executor,
    commandsPerSecond: 1,
    readline: { question: async () => "", close: () => undefined },
    writeLine: (line) => output.push(line),
  });

  await cli.executeLine("inventory clear all");

  assert.equal(adminCalls, 1);
  assert.equal(worldPlans, 0);
  assert.equal(output.some((line) => line.includes("/clear bot")), true);
});

class LcgRandom implements RandomSource {
  constructor(private state: number) {}

  next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
}
