import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { DigCapability } from "../../../src/capabilities/Dig";

interface FakeBlock {
  readonly name: string;
  readonly stateId: number;
  readonly boundingBox: "block" | "empty";
}

const oakLog: FakeBlock = {
  name: "oak_log",
  stateId: 1,
  boundingBox: "block",
};
const air: FakeBlock = { name: "air", stateId: 0, boundingBox: "empty" };

test("dig waits for the bot to land and raycasts the expected block", async () => {
  let currentBlock = oakLog;
  const waitCalls: number[] = [];
  const entity = { onGround: false };
  const digCalls: unknown[][] = [];

  const bot = {
    entity,
    heldItem: null,
    targetDigBlock: null,
    blockAt: () => currentBlock,
    canDigBlock: () => true,
    digTime: () => (entity.onGround ? 3_000 : 15_000),
    waitForTicks: async (ticks: number) => {
      waitCalls.push(ticks);
      entity.onGround = true;
    },
    dig: async (...args: unknown[]) => {
      digCalls.push(args);
      assert.equal(entity.onGround, true);
      currentBlock = air;
    },
    stopDigging: () => undefined,
  } as unknown as Bot;

  const result = await new DigCapability().execute(
    { position: { x: 3, y: -60, z: 0 } },
    createContext(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.block, "oak_log");
    assert.equal(result.value.tool, "hand");
    assert.equal(result.value.estimatedDurationMs, 3_000);
  }
  assert.deepEqual(waitCalls, [1, 1, 1]);
  assert.equal(digCalls.length, 1);
  assert.equal(digCalls[0]?.[0], oakLog);
  assert.equal(digCalls[0]?.[1], false);
  assert.equal(digCalls[0]?.[2], "raycast");
});

test("dig refuses to start when the target changes while landing", async () => {
  let currentBlock = oakLog;
  let digCalled = false;
  const entity = { onGround: false };

  const bot = {
    entity,
    heldItem: null,
    targetDigBlock: null,
    blockAt: () => currentBlock,
    canDigBlock: () => true,
    digTime: () => 3_000,
    waitForTicks: async () => {
      entity.onGround = true;
      currentBlock = {
        name: "birch_log",
        stateId: 2,
        boundingBox: "block",
      };
    },
    dig: async () => {
      digCalled = true;
    },
    stopDigging: () => undefined,
  } as unknown as Bot;

  const result = await new DigCapability().execute(
    { position: { x: 3, y: -60, z: 0 } },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "WORLD_CHANGED");
  assert.equal(digCalled, false);
});

test("dig reports BLOCKED when the server restores the target block", async () => {
  let currentBlock = oakLog;

  const bot = {
    entity: { onGround: true },
    heldItem: null,
    targetDigBlock: null,
    blockAt: () => currentBlock,
    canDigBlock: () => true,
    digTime: () => 3_000,
    waitForTicks: async () => {
      currentBlock = oakLog;
    },
    dig: async () => {
      currentBlock = air;
    },
    stopDigging: () => undefined,
  } as unknown as Bot;

  const result = await new DigCapability().execute(
    { position: { x: 3, y: -60, z: 0 } },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "BLOCKED");
});

function createContext(bot: Bot): ExecutionContext {
  const runtime = { bot } as unknown as MinecraftRuntime;

  return {
    runtime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
    deferCancellationUntil: () => undefined,
  };
}

test("an unobservable cell after digging is unknown, not successful removal", async () => {
  let current: FakeBlock | null = oakLog;
  const bot = {
    entity: { onGround: true }, heldItem: null, targetDigBlock: null,
    blockAt: () => current, canDigBlock: () => true, digTime: () => 3000,
    waitForTicks: async () => undefined,
    dig: async () => { current = null; }, stopDigging: () => undefined,
  } as unknown as Bot;
  const result = await new DigCapability().execute({ position: { x: 3, y: -60, z: 0 } }, createContext(bot));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "WORLD_CHANGED");
    assert.equal(result.error.facts?.verification, "unknown");
  }
});
