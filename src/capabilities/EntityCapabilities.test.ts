import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";
import { AttackCapability } from "./Attack";
import type { ExecutionContext } from "./Capability";
import { InteractEntityCapability } from "./InteractEntity";

test("attack requires a hurt, death, or disappearance confirmation", async () => {
  const { bot, entity, emitter } = fakeEntityBot();
  bot.attack = () => emitter.emit("entityHurt", entity);

  const result = await new AttackCapability().execute(
    { entityId: 42, expectedType: "zombie" },
    context(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.outcome, "hurt");
});

test("interact_entity confirms an entity update on the main hand", async () => {
  const { bot, entity, emitter } = fakeEntityBot("cow");
  bot.activateEntity = async () => {
    emitter.emit("entityUpdate", entity);
  };

  const result = await new InteractEntityCapability().execute(
    {
      entityId: 42,
      expectedType: "cow",
      hand: "hand",
      interaction: "activate",
    },
    context(bot),
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.confirmedBy, "entity_update");
});

test("interact_entity never treats a sent request as confirmation", async () => {
  const { bot } = fakeEntityBot("cow");

  const result = await new InteractEntityCapability().execute(
    { entityId: 42, hand: "hand", interaction: "use_on" },
    context(bot),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
});

function fakeEntityBot(name = "zombie"): {
  bot: Bot;
  entity: Entity;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const entity = {
    id: 42,
    name,
    type: "mob",
    height: 1.8,
    position: new Vec3(1, 64, 1),
  } as Entity;
  const bot = Object.assign(emitter, {
    entities: { 42: entity },
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
    },
    currentWindow: null,
    lookAt: async () => undefined,
    attack: () => undefined,
    activateEntity: async () => undefined,
    useOn: () => undefined,
    waitForTicks: async () => undefined,
    closeWindow: async () => undefined,
  }) as unknown as Bot;
  return { bot, entity, emitter };
}

function context(bot: Bot): ExecutionContext {
  return {
    runtime: { bot } as unknown as MinecraftRuntime,
    world: {} as WorldQueries,
    signal: new AbortController().signal,
  };
}
