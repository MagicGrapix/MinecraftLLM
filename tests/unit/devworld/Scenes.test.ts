import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { containsBounds, boundsVolume } from "../../../src/devworld/ArenaBounds";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { WorldBuilder } from "../../../src/devworld/WorldBuilder";
import { WorldBuilderCli } from "../../../src/devworld/cli/WorldBuilderCli";
import { parseWorldCommand } from "../../../src/devworld/cli/parseWorldCommand";
import type { WorldControllerRuntime } from "../../../src/devworld/controller/WorldControllerRuntime";
import type { CommandExecutor } from "../../../src/devworld/execution/CommandExecutor";
import { SceneActor } from "../../../src/devworld/scenes/SceneActor";
import { SceneController } from "../../../src/devworld/scenes/SceneController";
import { SCENES, getScene } from "../../../src/devworld/scenes/SceneCatalog";
import { createScenePlan, PHOTO_ACTOR, type PreparedScene } from "../../../src/devworld/scenes/ScenePlan";
import { sceneMismatch } from "../../../src/devworld/scenes/SceneVerification";

const config = loadWorldBuilderConfig({});

test("scene grammar is explicit and preview cannot reset the world", () => {
  assert.deepEqual(parseWorldCommand("scene list"), { kind: "scene_list" });
  assert.deepEqual(parseWorldCommand("scene 2"), { kind: "scene", id: 2 });
  assert.deepEqual(parseWorldCommand("preview scene 4"), { kind: "preview", command: { kind: "scene", id: 4 } });
  for (const text of ["scene", "scene 0", "scene 1.5", "scene 1 reset", "preview scene list"]) {
    assert.throws(() => parseWorldCommand(text));
  }
  assert.throws(() => getScene(99), /Unknown scene/);
});

for (const scene of SCENES) {
  test(`scene ${scene.id} is repeatable, bounded and touches only the photo actor`, () => {
    const a = createScenePlan(config, scene);
    const b = createScenePlan(config, scene);
    assert.deepEqual(a.plan.commands, b.plan.commands);
    assert.deepEqual(a.expected, b.expected);
    assert.equal(a.expected.length, boundsVolume(a.bounds));
    assert.ok(containsBounds(config.arena, a.bounds));
    assert.ok(a.plan.commands.length < 80, "Avoid a setblock per cube.");
    assert.ok(a.plan.commands.every((c) => !c.affectedBounds || containsBounds(a.bounds, c.affectedBounds)));
    const commands = a.plan.commands.map((c) => c.text);
    assert.ok(commands.includes(`clear ${PHOTO_ACTOR}`));
    assert.equal(PHOTO_ACTOR, "bot");
    assert.ok(commands.every((c) => !/\bworld_controller\b|@a|^place |^gamerule /.test(c)));
    assert.ok(commands.filter((c) => c.startsWith("kill ")).every((c) => c.includes("type=!minecraft:player,x=22,y=-64,z=22,dx=20,dy=13,dz=20")));
    assert.ok(commands.filter((c) => c.includes("minecraft:oak_leaves")).every((c) => c.includes("[persistent=true]")));
    assert.ok(a.plan.commands.filter((c) => c.text.startsWith("fill ")).every((c) => c.estimatedBlocksChanged! <= config.maxFillBlocks));
  });
}

test("scene plans validate all inputs before any command is sent", () => {
  assert.throws(() => createScenePlan(loadWorldBuilderConfig({ WORLD_ARENA_MAX_X: "40" }), SCENES[0]), /outside/);
  assert.throws(() => createScenePlan(loadWorldBuilderConfig({ WORLD_CONTROLLER_USERNAME: "BOT" }), SCENES[0]), /reserved/);
  assert.doesNotThrow(() => createScenePlan(loadWorldBuilderConfig({ WORLD_AGENT_USERNAME: "BOT" }), SCENES[0]));
  assert.throws(() => createScenePlan(loadWorldBuilderConfig({ WORLD_MAX_PLAN_COMMANDS: "5" }), SCENES[0]), /maximum/);
  assert.throws(() => createScenePlan(config, { ...SCENES[0], regions: [{ block: "oak_log", min: { x: 99, y: 1, z: 0 }, max: { x: 99, y: 1, z: 0 } }] }), /outside/);
  assert.throws(() => createScenePlan(config, { ...SCENES[0], actor: { ...SCENES[0].actor, hand: "missing_material" } }), /Unknown/);
  assert.throws(() => createScenePlan(config, { ...SCENES[0], camera: { ...SCENES[0].camera, pitch: NaN } }), /rotation/);
});

test("shelter cells match its ASCII drawing, including two-high entrance, window and air inside", () => {
  const scene = createScenePlan(config, SCENES[3]);
  const blocks = new Map(scene.expected.map((cell) => [`${cell.position.x},${cell.position.y},${cell.position.z}`, cell.block]));
  const at = (x: number, y: number, z: number) => blocks.get(`${32 + x},${config.surfaceY + y},${32 + z}`);
  assert.equal(at(0, 1, 2), "air");
  assert.equal(at(0, 2, 2), "air");
  assert.equal(at(-2, 1, 0), "oak_planks");
  assert.equal(at(-2, 2, 0), "air");
  assert.equal(at(0, 1, 0), "air");
  assert.equal(at(0, 2, 0), "air");
  assert.equal(at(0, 0, 0), "oak_planks");
  assert.equal(at(0, 3, 0), "oak_planks");
  assert.equal(scene.plan.commands.some((c) => /door/.test(c.text)), false);
});

test("loose items cannot be picked up or despawn; observation detects missing drops", () => {
  const scene = createScenePlan(config, SCENES[1]);
  assert.match(scene.plan.commands.find((c) => c.text.startsWith("summon "))!.text, /PickupDelay:32767s,Age:-32768s,NoGravity:1b/);
  const observed = sceneBots(scene);
  assert.equal(sceneMismatch(scene, observed.controller, observed.actor), null);
  observed.controller.entities = {};
  assert.match(sceneMismatch(scene, observed.controller, observed.actor)!, /Loose oak_log/);
});

test("verification reports unloaded/wrong cells and missing actor or held item", () => {
  const scene = createScenePlan(config, SCENES[0]);
  const observed = sceneBots(scene);
  assert.equal(sceneMismatch(scene, observed.controller, observed.actor), null);
  assert.match(sceneMismatch(scene, observed.controller, null)!, /not visible/);
  assert.match(sceneMismatch(scene, observed.controller, { heldItem: null } as Bot)!, /held item/);
  observed.controller.blockAt = () => null;
  assert.match(sceneMismatch(scene, observed.controller, observed.actor)!, /unloaded/);
});

test("actor is lazy, separate, reuses its connection and quits with the controller", async () => {
  const emitter = new EventEmitter();
  let connections = 0;
  let quits = 0;
  const bot = Object.assign(emitter, { game: { dimension: "overworld" }, quit: () => { quits++; emitter.emit("end", "quit"); } }) as unknown as Bot;
  const actor = new SceneActor(config, (options) => {
    connections++;
    assert.equal(options.username, PHOTO_ACTOR);
    assert.equal(options.physicsEnabled, false);
    queueMicrotask(() => emitter.emit("spawn"));
    return bot;
  });
  assert.equal(connections, 0);
  await assert.rejects(actor.connect({ BOT: {} } as unknown as Bot["players"]), /already connected/);
  assert.equal(connections, 0);
  await actor.connect({});
  await actor.connect({});
  assert.equal(connections, 1);
  assert.equal(bot.listenerCount("chat"), 0);
  actor.close();
  actor.close();
  assert.equal(quits, 1);
  await assert.rejects(actor.connect({}), /closed/);
});

test("an actor kick rejects setup and cleans up its session", async () => {
  const bot = Object.assign(new EventEmitter(), { quit: () => undefined }) as unknown as Bot;
  const actor = new SceneActor(config, () => { queueMicrotask(() => bot.emit("kicked", "not allowed", true)); return bot; });
  await assert.rejects(actor.connect({}), /not allowed/);
  assert.equal(actor.bot, null);
  assert.equal(bot.listenerCount("spawn"), 0);
});

test("scene runner refuses a connected regular agent before connecting or executing", async () => {
  let connected = 0;
  let executed = 0;
  const runtime = { isConnected: true, isOperatorVerified: true, bot: { players: { bot: {} } } } as unknown as WorldControllerRuntime;
  const executor = { execute: async () => { executed++; throw new Error("unreachable"); } } as unknown as CommandExecutor;
  const actor = { connect: async () => { connected++; }, close: () => undefined } as unknown as SceneActor;
  const scenes = new SceneController(config, runtime, executor, actor);
  await assert.rejects(scenes.apply(scenes.prepare(1)), /regular agent/);
  assert.equal(connected, 0);
  assert.equal(executed, 0);
});

test("scene runner reports command failure without retry and verifies successful commands", async () => {
  const prepared = createScenePlan(config, SCENES[2]);
  const observed = sceneBots(prepared);
  const runtime = { isConnected: true, isOperatorVerified: true, bot: observed.controller } as unknown as WorldControllerRuntime;
  let executions = 0;
  let fail = true;
  const executor = { execute: async () => { executions++; return { status: fail ? "failed" : "completed", error: "command refused" }; } } as unknown as CommandExecutor;
  const actor = { bot: observed.actor, connect: async () => undefined, close: () => undefined } as unknown as SceneActor;
  const scenes = new SceneController(config, runtime, executor, actor);
  await assert.rejects(scenes.apply(prepared), /not rolled back/);
  assert.equal(executions, 1);
  fail = false;
  await scenes.apply(prepared);
  assert.equal(executions, 2);
  await scenes.apply(prepared);
  assert.equal(executions, 3, "An owned photo connection must allow the next scene too.");
  scenes.close();
  await assert.rejects(scenes.apply(prepared), /connected/);
});

test("an owned photo actor does not bypass the guard for a differently named regular agent", async () => {
  const otherConfig = loadWorldBuilderConfig({ WORLD_AGENT_USERNAME: "regular_agent" });
  const prepared = createScenePlan(otherConfig, SCENES[0]);
  const observed = sceneBots(prepared);
  observed.controller.players.REGULAR_AGENT = {} as Bot["players"][string];
  const runtime = { isConnected: true, isOperatorVerified: true, bot: observed.controller } as unknown as WorldControllerRuntime;
  const executor = { execute: async () => { assert.fail("No commands may be sent."); } } as unknown as CommandExecutor;
  const actor = { bot: observed.actor, connect: async () => { assert.fail("No connection may be started."); } } as unknown as SceneActor;
  await assert.rejects(new SceneController(otherConfig, runtime, executor, actor).apply(prepared), /regular agent/);
});

test("scene list and preview are read-only; CLI never announces ready on failure", async () => {
  const output: string[] = [];
  let applies = 0;
  const cli = new WorldBuilderCli({
    runtime: {} as WorldControllerRuntime,
    builder: new WorldBuilder({ config }), executor: {} as CommandExecutor,
    commandsPerSecond: 2, readline: { question: async () => "", close: () => undefined },
    writeLine: (line) => output.push(line),
    scenes: { prepare: (id) => createScenePlan(config, getScene(id)), apply: async () => { applies++; throw new Error("refused"); } },
  });
  await cli.executeLine("scene list");
  await cli.executeLine("preview scene 4");
  assert.equal(applies, 0);
  assert.ok(output.some((line) => line.includes("Matching blueprint")));
  await assert.rejects(cli.executeLine("scene 4"), /refused/);
  assert.equal(applies, 1);
  assert.ok(output.every((line) => !line.includes("Scene 4 ready")));
  cli.close();
});

function sceneBots(scene: PreparedScene): { controller: Bot; actor: Bot } {
  const cells = new Map(scene.expected.map((cell) => [`${cell.position.x},${cell.position.y},${cell.position.z}`, cell.block]));
  const p = scene.actor.position;
  const controller = {
    blockAt: (position: Vec3) => { const name = cells.get(`${position.x},${position.y},${position.z}`); return name ? { name } : null; },
    players: { [PHOTO_ACTOR]: { entity: { position: new Vec3(p.x, p.y, p.z) } } },
    entities: Object.fromEntries(scene.drops.map((d, id) => [id, { name: "item", position: new Vec3(d.position.x, d.position.y, d.position.z), getDroppedItem: () => ({ name: d.item, count: 1 }) }])),
  } as unknown as Bot;
  return { controller, actor: { heldItem: { name: scene.scene.actor.hand, count: 1 } } as Bot };
}
