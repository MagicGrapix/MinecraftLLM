import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { PlaceCapability, type PlaceInput } from "../../../src/capabilities/Place";
import { MineflayerBuildOperations } from "../../../src/building/MineflayerBuildOperations";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { Executor } from "../../../src/execution/Executor";
import { TaskFactory } from "../../../src/execution/TaskFactory";
import { subscribeTrace } from "../../../src/TraceLog";
import { testBlock } from "../../support/building";

const target = new Vec3(0, 0, 0);
const input: PlaceInput = { referencePosition: { x: 0, y: -1, z: 0 }, face: "top" };
const timing = { pollIntervalMs: 2, timeoutMs: 40 };
const block = (name: string, position = target) => Object.assign(testBlock(name, position), {
  type: name === "air" ? 0 : name === "oak_planks" ? 1 : 2,
  stateId: name === "air" ? 0 : name === "oak_planks" ? 1 : 2,
});

function fixture() {
  let cell: ReturnType<typeof block> | null = block("air");
  const client = new EventEmitter();
  const item = { name: "oak_planks", count: 8, slot: 36 };
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    heldItem: item,
    registry: { blocksByName: { oak_planks: { name: "oak_planks" } } },
    inventory: { items: () => [item] },
    equip: async () => {},
    entity: { position: new Vec3(1.5, 0, 0.5), eyeHeight: 1.62, onGround: true },
    blockAt: (p: Vec3) => p.equals(target) ? cell : block(p.y < 0 ? "grass_block" : "air", p),
    placeBlock: async () => {},
  }) as unknown as Bot;
  const abort = new AbortController();
  const barriers: Promise<unknown>[] = [];
  const context = { runtime: { bot }, world: {}, signal: abort.signal,
    deferCancellationUntil: (operation: Promise<unknown>) => { barriers.push(operation); },
  } as unknown as ExecutionContext;
  const local = (name: string | null) => { cell = name === null ? null : block(name); };
  const server = (name: string) => {
    local(name); client.emit("block_change", { location: target, type: cell!.stateId });
  };
  const clean = () => {
    for (const event of ["block_change", "multi_block_change"]) assert.equal(client.listenerCount(event), 0, event);
    for (const event of ["end", "death", "respawn"] as const) assert.equal(bot.listenerCount(event), 0, event);
  };
  return { bot, abort, context, barriers, local, server, clean };
}

test("builder recovers actual Mineflayer air refusal with one placement and a later server confirmation", async () => {
  const f = fixture();
  // Run the installed plugin, not a stub of its refusal logic.
  const inject = require("mineflayer/lib/plugins/place_block") as (bot: Bot) => void;
  let sent = 0;
  Object.assign(f.bot, { _genericPlace: async () => {
    sent++;
    setImmediate(() => {
      f.bot.emit(`blockUpdate:${new Vec3(0, -1, 0)}` as "blockUpdate", block("grass_block"), block("grass_block"));
      f.server("air");
      f.bot.emit(`blockUpdate:${target}` as "blockUpdate", block("air"), block("air"));
      setTimeout(() => f.server("oak_planks"), 10);
    });
  } });
  inject(f.bot);
  const stages: { stage: string; cause?: string; observed: string }[] = [];
  const unsubscribe = subscribeTrace((event, data) => { if (event === "place.confirmation") stages.push(data as typeof stages[number]); });
  try {
    const result = await new MineflayerBuildOperations(f.context).place(input, "oak_planks");
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(sent, 1);
    assert.equal(f.barriers.length, 1);
    assert.match(stages.find(s => s.stage === "settled")?.cause ?? "", /block is still air/);
    assert.equal(stages.at(-1)?.stage, "confirmed");
    assert.equal(stages.at(-1)?.observed, "oak_planks");
    f.clean();
    assert.equal(f.bot.eventNames().length, 0, "Mineflayer placement listeners must settle too");
  } finally { unsubscribe(); }
});

for (const scenario of ["during_call", "late_success", "late_error", "section_packet", "cache_lags_packet"] as const) {
  test(`place confirms expected server state: ${scenario}`, async () => {
    const f = fixture(); let sent = 0;
    f.bot.placeBlock = async () => {
      sent++;
      if (scenario === "during_call") { f.server("oak_planks"); await delay(10); }
      else if (scenario === "section_packet") {
        f.local("oak_planks");
        f.bot._client.emit("multi_block_change", { chunkCoordinates: { x: 0, y: 0, z: 0 }, records: [1n << 12n] });
      } else if (scenario === "cache_lags_packet") {
        f.bot._client.emit("block_change", { location: target, type: 1 });
        setTimeout(() => f.local("oak_planks"), 10);
      } else {
        setTimeout(() => f.server("oak_planks"), 10);
        if (scenario === "late_error") throw new Error("ambiguous refusal");
      }
    };
    const result = await new PlaceCapability({ ...timing, timeoutMs: 500 }).execute(input, f.context);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value, { item: "oak_planks", position: { x: 0, y: 0, z: 0 } });
    assert.equal(sent, 1); f.clean();
  });
}

for (const scenario of ["air", "wrong_block", "prediction", "other_position", "unknown", "rolled_back"] as const) {
  test(`place does not turn ${scenario} into success or resend placement`, async () => {
    const f = fixture(); let sent = 0;
    f.bot.placeBlock = async () => {
      sent++;
      if (scenario === "air") f.server("air");
      if (scenario === "wrong_block") f.server("dirt");
      if (scenario === "prediction") f.local("oak_planks");
      if (scenario === "other_position") {
        f.local("oak_planks");
        f.bot._client.emit("block_change", { location: target.offset(1, 0, 0), type: 1 });
      }
      if (scenario === "unknown") { f.server("oak_planks"); f.local(null); }
      if (scenario === "rolled_back") { f.server("oak_planks"); f.server("air"); }
      throw new Error("original Mineflayer error");
    };
    const result = await new PlaceCapability(timing).execute(input, f.context);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
    assert.equal(result.error.facts?.cause, "original Mineflayer error");
    assert.equal(result.error.facts?.expected, "oak_planks");
    assert.equal(result.error.facts?.verification, scenario === "unknown" ? "unknown" : ["prediction", "other_position"].includes(scenario) ? "unconfirmed" : "mismatch");
    assert.equal(sent, 1); f.clean();
  });
}

test("a resolved Mineflayer operation alone does not confirm placement", async () => {
  const f = fixture();
  const result = await new PlaceCapability(timing).execute(input, f.context);
  assert.ok(!result.ok && result.error.code === "ACTION_NOT_CONFIRMED");
  assert.equal(result.error.facts?.cause, undefined);
  f.clean();
});

for (const scenario of ["empty_hand", "non_block", "missing_support", "occupied", "unloaded"] as const) {
  test(`place rejects ${scenario} before sending or installing confirmation observers`, async () => {
    const f = fixture();
    f.bot.placeBlock = async () => assert.fail("Should not place");
    if (scenario === "empty_hand") Object.assign(f.bot, { heldItem: null });
    if (scenario === "non_block") Object.assign(f.bot, { heldItem: { name: "stick" } });
    if (scenario === "missing_support") f.bot.blockAt = () => null;
    if (scenario === "occupied") f.local("dirt");
    if (scenario === "unloaded") f.local(null);
    const result = await new PlaceCapability(timing).execute(input, f.context);
    assert.ok(!result.ok);
    assert.equal(result.error.code, { empty_hand: "MISSING_ITEM", non_block: "INVALID_ARGUMENT", missing_support: "TARGET_NOT_FOUND", occupied: "BLOCKED", unloaded: "WORLD_CHANGED" }[scenario]);
    assert.equal(f.barriers.length, 0); f.clean();
  });
}

for (const event of ["end", "death", "respawn"] as const) {
  for (const when of ["during_call", "during_confirmation"] as const) {
    test(`${event} ${when} cannot use an earlier confirmation or stale cache as success`, async () => {
      const f = fixture();
      const invalidate = () => { if (event === "end") f.bot.emit("end", "test disconnect"); else f.bot.emit(event); };
      f.bot.placeBlock = async () => {
        if (when === "during_call") { f.server("oak_planks"); invalidate(); }
        else setTimeout(() => { invalidate(); f.server("oak_planks"); }, 5);
      };
      const result = await new PlaceCapability().execute(input, f.context);
      assert.ok(!result.ok && result.error.code === "WORLD_CHANGED");
      assert.equal(result.error.facts?.verification, "unknown"); f.clean();
    });
  }
}

test("stop interrupts polling and detaches all observers", async () => {
  const f = fixture();
  f.bot.placeBlock = async () => { setTimeout(() => f.abort.abort(new Error("test stop")), 5); };
  await assert.rejects(new PlaceCapability().execute(input, f.context), /test stop/);
  f.clean();
});

test("Executor retains place lock after stop and server confirmation until Mineflayer settles", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void, sent = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.bot.placeBlock = async () => { sent++; f.server("oak_planks"); entered(); await pending; };
  const registry = new CapabilityRegistry(); registry.register(new PlaceCapability());
  const executor = new Executor({ runtime: f.context.runtime, world: f.context.world, registry, cancellationGraceMs: 0 });
  const tasks = new TaskFactory();
  const task = () => tasks.create({ capability: "place", input });
  const running = executor.execute(task());
  await started;
  executor.abortCurrent();
  const stopped = await running;
  assert.ok(!stopped.ok && stopped.error.code === "INTERRUPTED");
  assert.equal(stopped.error.facts?.stillSettling, true);
  const concurrent = await executor.execute(task());
  assert.ok(!concurrent.ok && concurrent.error.code === "BLOCKED");
  release(); await executor.waitForIdle(500); await delay(0);
  assert.equal(sent, 1); f.clean();
});
