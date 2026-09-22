import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { Window } from "prismarine-windows";
import { Vec3 } from "vec3";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import { ContainerSessionManager } from "../../../src/runtime/ContainerSessionManager";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { CloseContainerCapability } from "../../../src/capabilities/CloseContainer";
import { OpenContainerCapability } from "../../../src/capabilities/OpenContainer";
import { TransferItemCapability } from "../../../src/capabilities/TransferItem";

test("open, transfer, and close use one opaque container session", async () => {
  const { bot, counts } = fakeContainerBot("chest");
  const sessions = new ContainerSessionManager(
    bot,
    () => "00000000-0000-4000-8000-000000000010",
  );
  const context = createContext(bot);

  const opened = await new OpenContainerCapability(sessions).execute(
    { position: { x: 1, y: 64, z: 1 }, expectedBlock: "chest" },
    context,
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const transferred = await new TransferItemCapability(sessions).execute(
    {
      sessionId: opened.value.sessionId,
      direction: "deposit",
      item: "oak_log",
      quantity: 2,
    },
    context,
  );
  assert.equal(transferred.ok, true);
  assert.deepEqual(counts(), { inventory: 1, container: 2 });

  const closed = await new CloseContainerCapability(sessions).execute(
    { sessionId: opened.value.sessionId },
    context,
  );
  assert.equal(closed.ok, true);
  assert.equal(bot.currentWindow, null);
  assert.equal(sessions.snapshot(), null);
});

test("open_container explicitly excludes furnaces", async () => {
  const { bot } = fakeContainerBot("furnace");
  const sessions = new ContainerSessionManager(bot);
  const result = await new OpenContainerCapability(sessions).execute(
    { position: { x: 1, y: 64, z: 1 } },
    createContext(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "BLOCKED");
    assert.equal(result.error.facts?.specializedCapability, "open_furnace");
  }
});

function fakeContainerBot(blockName: string): {
  bot: Bot;
  counts: () => { inventory: number; container: number };
} {
  const emitter = new EventEmitter();
  const position = new Vec3(1, 64, 1);
  const block = {
    name: blockName,
    boundingBox: "block",
    position,
  };
  let inventory = 3;
  let container = 0;
  let currentWindow: Window | null = null;
  const window = {
    id: 2,
    type: "minecraft:chest",
    containerItems: () => [],
    count: () => inventory,
    containerCount: () => container,
    deposit: async (_type: number, _metadata: number | null, count: number) => {
      inventory -= count;
      container += count;
    },
    withdraw: async (
      _type: number,
      _metadata: number | null,
      count: number,
    ) => {
      inventory += count;
      container -= count;
    },
  } as unknown as Window;
  const bot = Object.assign(emitter, {
    entity: { position: { distanceTo: () => 2 } },
    registry: {
      itemsByName: { oak_log: { id: 17, name: "oak_log" } },
    },
    blockAt: () => block,
    canSeeBlock: () => true,
    lookAt: async () => undefined,
    blockAtCursor: () => block,
    openContainer: async () => {
      currentWindow = window;
      return window;
    },
    closeWindow: async (toClose: Window) => {
      if (currentWindow === toClose) currentWindow = null;
    },
  }) as unknown as Bot;
  Object.defineProperty(bot, "currentWindow", {
    configurable: true,
    get: () => currentWindow,
  });

  return { bot, counts: () => ({ inventory, container }) };
}

function createContext(bot: Bot): ExecutionContext {
  return {
    runtime: { bot } as unknown as MinecraftRuntime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
    deferCancellationUntil: () => undefined,
  };
}
