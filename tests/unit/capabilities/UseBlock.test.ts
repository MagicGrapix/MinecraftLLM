import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { UseBlockCapability } from "../../../src/capabilities/UseBlock";

test("use_block confirms a lever state change after exact raycast", async () => {
  const position = new Vec3(1, 64, 1);
  let stateId = 1;
  const block = () => ({
    name: "lever",
    stateId,
    boundingBox: "block",
    position,
  });
  const bot = fakeBot(block);
  bot.activateBlock = async () => {
    stateId = 2;
  };

  const result = await new UseBlockCapability().execute(
    { position: { x: 1, y: 64, z: 1 }, hand: "hand" },
    context(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.stateIdBefore, 1);
    assert.equal(result.value.stateIdAfter, 2);
  }
});

test("use_block refuses containers before sending interaction", async () => {
  let activated = false;
  const position = new Vec3(1, 64, 1);
  const bot = fakeBot(() => ({
    name: "chest",
    stateId: 1,
    boundingBox: "block",
    position,
  }));
  bot.activateBlock = async () => {
    activated = true;
  };

  const result = await new UseBlockCapability().execute(
    { position: { x: 1, y: 64, z: 1 }, hand: "hand" },
    context(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "BLOCKED");
    assert.equal(result.error.facts?.requiredCapability, "open_container");
  }
  assert.equal(activated, false);
});

function fakeBot(blockAt: () => unknown): Bot {
  const emitter = new EventEmitter();
  const block = blockAt() as { position: Vec3 };
  return Object.assign(emitter, {
    currentWindow: null,
    entity: { position: { distanceTo: () => 2 } },
    blockAt,
    canSeeBlock: () => true,
    lookAt: async () => undefined,
    blockAtCursor: () => block,
    activateBlock: async () => undefined,
    waitForTicks: async () => undefined,
    closeWindow: async () => undefined,
  }) as unknown as Bot;
}

function context(bot: Bot): ExecutionContext {
  return {
    runtime: { bot } as unknown as MinecraftRuntime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
    deferCancellationUntil: () => undefined,
  };
}
