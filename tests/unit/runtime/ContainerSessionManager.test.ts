import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import type { Window } from "prismarine-windows";
import { ContainerSessionManager } from "../../../src/runtime/ContainerSessionManager";

test("container sessions do not reuse Minecraft window ids as public ids", async () => {
  const firstWindow = { id: 7, type: "minecraft:chest" } as Window;
  const secondWindow = { id: 7, type: "minecraft:chest" } as Window;
  let currentWindow: Window | null = firstWindow;
  const bot = {
    on: () => undefined,
    get currentWindow() {
      return currentWindow;
    },
    closeWindow: async (window: Window) => {
      if (currentWindow === window) currentWindow = null;
    },
  } as unknown as Bot;
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  const sessions = new ContainerSessionManager(bot, () => ids.shift()!);

  const first = sessions.create(firstWindow, { x: 1, y: 2, z: 3 });
  await sessions.close(first.sessionId);
  currentWindow = secondWindow;
  const second = sessions.create(secondWindow, { x: 4, y: 5, z: 6 });

  assert.equal(first.windowId, second.windowId);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(sessions.resolve(first.sessionId).ok, false);
  assert.equal(sessions.resolve(second.sessionId).ok, true);
});

test("closeActive is idempotent while a close is pending", async () => {
  const window = { id: 3, type: "minecraft:barrel" } as Window;
  let currentWindow: Window | null = window;
  let releasesClose!: () => void;
  let closeCalls = 0;
  const bot = {
    on: () => undefined,
    get currentWindow() {
      return currentWindow;
    },
    closeWindow: async () => {
      closeCalls += 1;
      await new Promise<void>((resolve) => {
        releasesClose = resolve;
      });
      currentWindow = null;
    },
  } as unknown as Bot;
  const sessions = new ContainerSessionManager(
    bot,
    () => "00000000-0000-4000-8000-000000000003",
  );
  sessions.create(window, { x: 1, y: 2, z: 3 });

  const first = sessions.closeActive();
  const second = sessions.closeActive();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  releasesClose();
  await first;
  assert.equal(sessions.snapshot(), null);
});

test("server close, death, respawn and disconnect invalidate sessions and permit reopening", () => {
  for (const event of ["windowClose", "death", "respawn", "end"]) {
    const window = { id: 1, type: "minecraft:chest" } as Window;
    const bot = Object.assign(new EventEmitter(), { currentWindow: window });
    const sessions = new ContainerSessionManager(bot as unknown as Bot);
    const first = sessions.create(window, { x: 0, y: 0, z: 0 });
    bot.emit(event, window);
    assert.equal(sessions.snapshot(), null);
    assert.equal(sessions.resolve(first.sessionId).ok, false);
    const second = sessions.create(window, { x: 1, y: 0, z: 0 });
    assert.notEqual(second.sessionId, first.sessionId);
    sessions.dispose();
    for (const name of ["windowClose", "death", "respawn", "end"]) assert.equal(bot.listenerCount(name), 0);
  }
});

test("snapshot reconciles silently replaced windows without closing the replacement", () => {
  const window = { id: 1, type: "minecraft:chest" } as Window;
  const bot = Object.assign(new EventEmitter(), { currentWindow: window, closeWindow: () => assert.fail("Unrelated window must remain open") });
  const sessions = new ContainerSessionManager(bot as unknown as Bot);
  sessions.create(window, { x: 0, y: 0, z: 0 });
  bot.currentWindow = { id: 1, type: "minecraft:barrel" } as Window;
  assert.equal(sessions.snapshot(), null);
  assert.ok(sessions.create(bot.currentWindow, { x: 1, y: 0, z: 0 }));
  sessions.dispose();
});
