import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { Block, Shape } from "prismarine-block";
import { Vec3 } from "vec3";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import { inspectBlockAccess } from "../../../src/world/BlockAccess";
import { MineflayerWorldQueries } from "../../../src/world/MineflayerWorldQueries";

test("block access inspects an exact reachable target without acting or mutating cached blocks", () => {
  const target = block("oak_log", new Vec3(3, 65, 0));
  for (const shape of target.shapes) Object.freeze(shape);
  Object.freeze(target.shapes);
  Object.freeze(target.position);
  Object.freeze(target);
  const bot = scene([target]);
  const world = new MineflayerWorldQueries({ bot } as MinecraftRuntime);

  const result = world.getBlockAccess(target.position);

  assert.equal(result.loaded, true);
  assert.equal(result.block, "oak_log");
  assert.equal(result.distanceFromEyes, Math.hypot(3, 0.12));
  assert.equal(result.reach, 5);
  assert.equal(result.withinReach, true);
  assert.equal(result.visible, true);
  assert.equal(result.canDig, true);
  assert.equal(result.reason, "accessible");
  assert.equal(result.blocker, null);
  assert.deepEqual(result.position, { x: 3, y: 65, z: 0 });
});

test("visibility is independent of camera yaw and pitch", () => {
  const target = block("oak_log", new Vec3(3, 65, 0));
  const bot = scene([target]);
  const before = inspectBlockAccess(bot, target.position);
  bot.entity.yaw = Math.PI;
  bot.entity.pitch = -Math.PI / 2;
  assert.deepEqual(inspectBlockAccess(bot, target.position), before);
});

test("an obstructed log identifies the leaves blocking its face", () => {
  const target = block("oak_log", new Vec3(3, 65, 0));
  const leaves = block("oak_leaves", new Vec3(2, 65, 0));
  const result = inspectBlockAccess(scene([target, leaves]), target.position);

  assert.equal(result.withinReach, true);
  assert.equal(result.visible, false);
  assert.equal(result.canDig, false);
  assert.equal(result.reason, "occluded");
  assert.deepEqual(result.blocker, { block: "oak_leaves", position: { x: 2, y: 65, z: 0 } });
});

test("one blocked ray does not hide another unobstructed face", () => {
  const target = block("oak_log", new Vec3(2, 64, 2));
  const obstacle = block("stone", new Vec3(1, 64, 2));
  const result = inspectBlockAccess(scene([target, obstacle]), target.position);

  assert.equal(result.visible, true);
  assert.equal(result.canDig, true);
  assert.equal(result.blocker, null);
});

test("a visible distant block is not diggable merely because it is visible", () => {
  const target = block("oak_log", new Vec3(8, 65, 0));
  const result = inspectBlockAccess(scene([target]), target.position);

  assert.equal(result.visible, true);
  assert.equal(result.withinReach, false);
  assert.equal(result.canDig, false);
  assert.equal(result.reason, "out_of_reach");
});

test("dig reach is face distance, not distance to the center or integer corner", () => {
  const target = block("oak_log", new Vec3(5, 65, 0));
  const result = inspectBlockAccess(scene([target]), target.position);

  assert.ok(result.distanceFromEyes! > result.reach);
  assert.equal(result.withinReach, true);
  assert.equal(result.canDig, true);
});

test("Mineflayer's separate center precheck still limits digging", () => {
  const target = block("oak_log", new Vec3(0, 60, 0));
  const result = inspectBlockAccess(scene([target]), target.position);

  // The top face is 4.62 blocks from the eyes, but canDigBlock's center gate fails.
  assert.equal(result.visible, true);
  assert.equal(result.withinReach, false);
  assert.equal(result.canDig, false);
  assert.equal(result.reason, "out_of_reach");
});

test("visibility respects the actual collision shape of a slab", () => {
  const target = block("stone_slab", new Vec3(0, 64, 0), [[0, 0, 0, 1, 0.5, 1]]);
  const result = inspectBlockAccess(scene([target], { feet: new Vec3(0.5, 66, 0.5) }), target.position);

  assert.equal(result.visible, true);
  assert.equal(result.canDig, true);
});

test("a ray passing through a slab's empty half is not obstructed", () => {
  const target = block("oak_log", new Vec3(3, 65, 0));
  const slab = block("stone_slab", new Vec3(2, 65, 0), [[0, 0, 0, 1, 0.25, 1]]);
  const result = inspectBlockAccess(scene([target, slab]), target.position);

  assert.equal(result.visible, true);
  assert.equal(result.canDig, true);
  assert.equal(result.blocker, null);
});

test("unloaded targets are unknown, not air", () => {
  const position = new Vec3(3, 65, 0);
  const result = inspectBlockAccess(scene([], { unloaded: (cell) => cell.equals(position) }), position);

  assert.deepEqual(result, {
    position: { x: 3, y: 65, z: 0 }, loaded: false, block: null,
    distanceFromEyes: null, reach: 5, withinReach: null, visible: null,
    canDig: false, reason: "unloaded", blocker: null,
  });
});

test("known air is empty, while a ray through unloaded terrain has unknown visibility", () => {
  const target = block("oak_log", new Vec3(3, 65, 0));
  const bot = scene([target], { unloaded: (cell) => cell.x === 1 });
  const air = inspectBlockAccess(bot, new Vec3(2, 66, 0));
  assert.equal(air.loaded, true);
  assert.equal(air.block, "air");
  assert.equal(air.visible, false);
  assert.equal(air.canDig, false);
  assert.equal(air.reason, "empty");

  const unknown = inspectBlockAccess(bot, target.position);
  assert.equal(unknown.loaded, true);
  assert.equal(unknown.withinReach, true);
  assert.equal(unknown.visible, null);
  assert.equal(unknown.canDig, false);
  assert.equal(unknown.reason, "visibility_unknown");
  assert.equal(unknown.blocker, null);
});

test("visible bedrock is not diggable", () => {
  const target = block("bedrock", new Vec3(3, 65, 0));
  target.diggable = false;
  const result = inspectBlockAccess(scene([target]), target.position);

  assert.equal(result.visible, true);
  assert.equal(result.withinReach, true);
  assert.equal(result.canDig, false);
  assert.equal(result.reason, "not_diggable");
});

test("local readiness distinguishes being airborne and an active dig", () => {
  const target = block("oak_log", new Vec3(3, 65, 0));
  const airborne = inspectBlockAccess(scene([target], { onGround: false }), target.position);
  assert.equal(airborne.withinReach, true);
  assert.equal(airborne.visible, true);
  assert.equal(airborne.canDig, false);
  assert.equal(airborne.reason, "not_on_ground");

  const busy = inspectBlockAccess(scene([target], { busy: target }), target.position);
  assert.equal(busy.canDig, false);
  assert.equal(busy.reason, "already_digging");
});

test("visibility probes are bounded and do not label uninspected distant terrain as clear", () => {
  const target = block("oak_log", new Vec3(100, 65, 0));
  let reads = 0;
  const bot = scene([target]);
  const readBlock = bot.blockAt.bind(bot);
  bot.blockAt = (position) => { reads += 1; return readBlock(position); };
  const result = inspectBlockAccess(bot, target.position);

  assert.equal(reads, 1);
  assert.equal(result.loaded, true);
  assert.equal(result.withinReach, false);
  assert.equal(result.visible, null);
  assert.equal(result.canDig, false);
});

test("unknown eye geometry is not replaced with invented measurements", () => {
  const target = block("oak_log", new Vec3(3, 65, 0));
  const bot = scene([target], { eyeHeight: NaN });
  const result = inspectBlockAccess(bot, target.position);
  assert.equal(result.distanceFromEyes, null);
  assert.equal(result.withinReach, null);
  assert.equal(result.visible, null);
  assert.equal(result.canDig, false);
  assert.equal(result.reason, "visibility_unknown");
});

test("eyes inside the target have no usable dig face, not an out-of-reach diagnosis", () => {
  const target = block("oak_log", new Vec3(0, 65, 0));
  const result = inspectBlockAccess(scene([target], { feet: new Vec3(0.5, 64, 0.5), eyeHeight: 1.5 }), target.position);
  assert.equal(result.distanceFromEyes, 0);
  assert.equal(result.visible, false);
  assert.equal(result.canDig, false);
  assert.equal(result.reason, "no_visible_face");
});

function block(name: string, position: Vec3, shapes: Shape[] = [[0, 0, 0, 1, 1, 1]]): Block {
  return {
    name, position, shapes, diggable: name !== "air",
    boundingBox: name === "air" ? "empty" : "block",
  } as Block;
}

function scene(blocks: Block[], options: {
  feet?: Vec3; eyeHeight?: number; onGround?: boolean;
  busy?: Block; unloaded?: (position: Vec3) => boolean;
} = {}): Bot {
  const cached = new Map(blocks.map((entry) => [entry.position.toString(), entry]));
  const feet = options.feet ?? new Vec3(0.5, 64, 0.5);
  const forbidden = (): never => { throw new Error("Block access must not perform physical actions."); };
  return {
    entity: { position: feet, eyeHeight: options.eyeHeight ?? 1.62, onGround: options.onGround ?? true, yaw: 0, pitch: 0 },
    targetDigBlock: options.busy ?? null,
    blockAt: (position: Vec3) => {
      const cell = position.floored();
      if (options.unloaded?.(cell)) return null;
      return cached.get(cell.toString()) ?? block("air", cell, []);
    },
    canDigBlock: (target: Block) => target.diggable && target.position.offset(0.5, 0.5, 0.5).distanceTo(feet.offset(0, 1.65, 0)) <= 5.1,
    lookAt: forbidden, dig: forbidden, setControlState: forbidden,
    chat: forbidden, world: { raycast: forbidden },
  } as unknown as Bot;
}
