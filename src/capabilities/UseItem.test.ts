import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";
import type { ExecutionContext } from "./Capability";
import { UseItemCapability } from "./UseItem";

test("instant item use confirms an inventory mutation", async () => {
  let count = 2;
  const bot = fakeBot(() => {
    count = 1;
  }, () => count);

  const result = await new UseItemCapability().execute(
    { expectedItem: "ender_pearl", hand: "hand", mode: "instant" },
    context(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.requestSent, true);
    assert.equal(result.value.effectConfirmed, true);
    assert.deepEqual(result.value.evidence, ["inventory_changed"]);
  }
});

test("local usingHeldItem does not claim a confirmed shield effect", async () => {
  const bot = fakeBot(() => undefined, () => 1, "shield");

  const result = await new UseItemCapability().execute(
    {
      expectedItem: "shield",
      hand: "hand",
      mode: "hold_then_release",
      holdTicks: 3,
    },
    context(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.requestSent, true);
    assert.equal(result.value.effectConfirmed, false);
    assert.deepEqual(result.value.evidence, []);
  }
});

function fakeBot(
  onFirstTick: () => void,
  count: () => number,
  itemName = "ender_pearl",
): Bot {
  const emitter = new EventEmitter();
  let tick = 0;
  return Object.assign(emitter, {
    heldItem: { name: itemName, count: count(), metadata: 0, slot: 36 },
    entity: { position: { x: 0, y: 0, z: 0 } },
    inventory: {
      slots: [],
      items: () => [
        { name: itemName, count: count(), metadata: 0, slot: 36 },
      ],
    },
    activateItem: () => undefined,
    deactivateItem: () => undefined,
    waitForTicks: async () => {
      tick += 1;
      if (tick === 1) onFirstTick();
    },
  }) as unknown as Bot;
}

function context(bot: Bot): ExecutionContext {
  return {
    runtime: { bot } as unknown as MinecraftRuntime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
  };
}
