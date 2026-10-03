import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { WorldControllerRuntime } from "../../../src/devworld/controller/WorldControllerRuntime";
import type { CommandTransport } from "../../../src/devworld/controller/MineflayerCommandTransport";

test("inventory reset requires OP initialization and targets only the configured agent", async () => {
  const config = loadWorldBuilderConfig({
    WORLD_AGENT_USERNAME: "test_bot",
  });
  const players: Record<string, { entity: { position: Vec3 } } | undefined> = {
    test_bot: { entity: { position: new Vec3(0, -60, 0) } },
  };
  const emitter = new EventEmitter();
  const bot = Object.assign(emitter, {
    game: { dimension: "overworld" },
    players,
    world: { getColumnAt: () => ({}) },
    quit: () => undefined,
  }) as unknown as Bot;
  const runtime = new WorldControllerRuntime(config, (options) => {
    assert.equal(options.physicsEnabled, false, "Only the admin observer is created without gravity.");
    queueMicrotask(() => emitter.emit("spawn"));
    return bot;
  });
  const commands: string[] = [];
  const transport: CommandTransport = {
    isClosed: false,
    subscribeClose: () => () => undefined,
    send: async (command: string) => {
      commands.push(command);
      const marker = /WB_OP_[a-f0-9]+/.exec(command)?.[0];
      return {
        command,
        sentAt: 0,
        responses: marker ? [marker] : [],
      };
    },
  };

  await runtime.connect();
  await assert.rejects(runtime.clearAgentInventory(), /not ready/);
  await runtime.initialize(transport);
  const result = await runtime.clearAgentInventory();

  assert.equal(result.command, "clear test_bot");
  assert.equal(commands.at(-1), "clear test_bot");
  players.test_bot = undefined;
  await assert.rejects(runtime.clearAgentInventory(), /not connected/);
  runtime.disconnect();
});
