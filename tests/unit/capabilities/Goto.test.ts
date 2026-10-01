import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { GotoCapability } from "../../../src/capabilities/Goto";
import { createGotoMovements } from "../../../src/capabilities/GotoMovements";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { Position } from "../../../src/shared/types";
import type { WorldQueries } from "../../../src/world/WorldQueries";

const target = { x: 3, y: -60, z: 0 };

test("goto records search timeout and nearby blocks without a second search", async () => {
  const { bot, context, emitter, calls } = createHarness(() => {
    emitter.emit("path_update", {
      status: "timeout",
      time: 5_001,
      visitedNodes: 240,
      generatedNodes: 320,
      path: [{ x: 1, y: -60, z: 0 }],
    });
  });

  const result = await new GotoCapability().execute(
    { position: target },
    context,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "TIMEOUT");
  assert.equal(result.error.facts?.reason, "Timeout");
  assert.equal(result.error.facts?.targetBlock, "oak_log");
  assert.equal(result.error.facts?.targetChunkLoaded, true);
  assert.equal(result.error.facts?.thinkTimeoutMs, 5_000);
  assert.deepEqual(result.error.facts?.lastSearch, {
    status: "timeout",
    timeMs: 5_001,
    visitedNodes: 240,
    generatedNodes: 320,
    pathLength: 1,
    bestSearchPosition: { x: 1, y: -60, z: 0 },
  });
  assert.deepEqual((result.error.facts?.approaches as unknown[])[0], {
    direction: "north",
    support: "grass_block",
    feet: "air",
    head: "air",
  });
  assert.equal(calls.setGoal, 1);
  assert.equal(emitter.listenerCount("path_update"), 0);
  assert.equal(emitter.listenerCount("path_reset"), 0);
  assert.equal(bot.entity.position.x, 0);
});

test("goto distinguishes an exhausted search from a timeout", async () => {
  const { context, emitter } = createHarness(() => {
    emitter.emit("path_update", {
      status: "noPath",
      time: 15,
      visitedNodes: 12,
      generatedNodes: 12,
      path: [],
    });
  });

  const result = await new GotoCapability().execute(
    { position: target },
    context,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "NO_PATH");
    assert.equal(result.error.retryable, false);
    assert.equal(result.error.facts?.reason, "NoPath");
    assert.equal(
      (result.error.facts?.lastSearch as { status: string }).status,
      "noPath",
    );
  }
});

test("goto ignores an empty partial path until the goal is reached", async () => {
  let activeGoal: unknown;
  const { context, emitter, entity } = createHarness((goal) => {
    activeGoal = goal;
    emitter.emit("path_update", {
      status: "partial",
      time: 40,
      visitedNodes: 431,
      generatedNodes: 525,
      path: [],
    });
  });

  let settled = false;
  const completion = new GotoCapability().execute(
    { position: target },
    context,
  );
  void completion.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  entity.position = new Vec3(2.5, -60, 0.5);
  emitter.emit("goal_reached", activeGoal);
  const result = await completion;
  assert.equal(result.ok, true);
});

test("goto does not claim success if goal_reached arrives away from the goal", async () => {
  const { context, emitter } = createHarness((goal) => {
    emitter.emit("goal_reached", goal);
  });

  const result = await new GotoCapability().execute(
    { position: target }, context,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "BLOCKED");
    assert.equal(result.error.facts?.reason, "arrival_not_stable");
  }
});

test("successful goto does not sample the world and removes listeners", async () => {
  const { context, emitter, entity, calls } = createHarness((goal) => {
    entity.position = new Vec3(2.5, -60, 0.5);
    emitter.emit("goal_reached", goal);
  });

  const result = await new GotoCapability().execute(
    { position: target },
    context,
  );
  assert.equal(result.ok, true);
  assert.equal(calls.blockReads, 0);
  assert.equal(emitter.listenerCount("path_update"), 0);
  assert.equal(emitter.listenerCount("path_reset"), 0);
});

test("goto clears a failed goal without a deferred stop poisoning the next navigation", async () => {
  let attempt = 0;
  const { bot, context, emitter, entity, calls } = createHarness((goal) => {
    if (attempt++ === 0) {
      emitter.emit("path_update", { status: "timeout", time: 5001, path: [], visitedNodes: 1, generatedNodes: 1 });
    } else {
      entity.position = new Vec3(2.5, -60, 0.5);
      emitter.emit("goal_reached", goal);
    }
  });
  const previous = bot.pathfinder.movements;
  const capability = new GotoCapability();
  const first = await capability.execute({ position: target }, context);
  assert.equal(first.ok, false);
  assert.equal(calls.clearGoal, 1);
  assert.equal(calls.stop, 0);
  assert.equal(bot.pathfinder.movements, previous);
  assert.equal((await capability.execute({ position: target }, context)).ok, true);
});

test("goto cancellation clears navigation and all listeners before completing", async () => {
  const { bot, context, emitter, calls } = createHarness(() => undefined);
  const abort = new AbortController();
  const completion = new GotoCapability().execute({ position: target }, { ...context, signal: abort.signal });
  abort.abort();
  await assert.rejects(completion, { name: "AbortError" });
  assert.equal(calls.clearGoal, 1);
  assert.equal(calls.stop, 0);
  for (const event of ["path_update", "path_reset", "blockUpdate", "end", "goal_reached", "goal_updated", "path_stop"]) {
    assert.equal(emitter.listenerCount(event), 0, event);
  }
  assert.equal(bot.pathfinder.goal, null);
});

test("goto interaction finds a visible face without requiring adjacency or digging the target", async () => {
  const { context, emitter, entity } = createHarness((goal) => {
    assert.ok(goal instanceof goals.GoalLookAtBlock);
    entity.position = new Vec3(0.5, -60, 0.5);
    emitter.emit("goal_reached", goal);
  });
  const result = await new GotoCapability().execute({ position: target, goal: "interact" }, context);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.goal, "interact");
    assert.ok(result.value.distanceToTarget > 1);
  }
});

test("goto does not claim interaction success through an occluded face", async () => {
  const { bot, context, emitter, entity } = createHarness((goal) => {
    entity.position = new Vec3(0.5, -60, 0.5);
    emitter.emit("goal_reached", goal);
  });
  bot.world.raycast = () => null;
  const result = await new GotoCapability().execute({ position: target, goal: "interact" }, context);
  assert.equal(result.ok, false);
});

test("goto interaction rejects absent targets and invalid reach", async () => {
  const { context, calls } = createHarness(() => undefined);
  const capability = new GotoCapability();
  const result = await capability.execute({ position: { x: 4, y: -60, z: 0 }, goal: "interact" }, context);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TARGET_NOT_FOUND");
  assert.equal(calls.setGoal, 0);
  for (const range of [0, 5]) assert.equal(capability.inputSchema.safeParse({ position: target, goal: "interact", range }).success, false);
});

test("goto waits for landing and corrects a goal reached only during a tower jump", async () => {
  const elevated = { x: 0, y: -56, z: 0 };
  let attempts = 0;
  const { context, emitter, entity, calls } = createHarness((goal) => {
    entity.onGround = false;
    entity.position = new Vec3(0.5, -55.8, 0.5);
    emitter.emit("goal_reached", goal);
    setTimeout(() => {
      entity.position = new Vec3(0.5, attempts++ === 0 ? -57 : -56, 0.5);
      entity.onGround = true;
      emitter.emit("physicsTick");
    }, 10);
  });
  const result = await new GotoCapability().execute({ position: elevated, range: 0 }, context);
  assert.equal(result.ok, true);
  assert.equal(calls.setGoal, 2);
  if (result.ok) assert.equal(result.value.position.y, -56);
  assert.equal(emitter.listenerCount("physicsTick"), 0);
});

test("goto scaffolding uses inventory items and respects per-task overrides", () => {
  const { bot, items } = createHarness(() => undefined);
  const movements = createGotoMovements(bot, target, {});
  assert.equal(movements.canDig, true);
  assert.equal(movements.allow1by1towers, true);
  assert.equal(movements.countScaffoldingItems(), 0);
  items.push({ type: bot.registry.itemsByName.dirt!.id, count: 6 });
  items.push({ type: bot.registry.itemsByName.oak_log!.id, count: 20 });
  assert.equal(movements.countScaffoldingItems(), 6);
  const walking = createGotoMovements(bot, target, { canDig: false, canPlace: false });
  assert.equal(walking.canDig, false);
  assert.equal(walking.allow1by1towers, false);
  assert.equal(walking.countScaffoldingItems(), 0);
  const targetBlock = { position: new Vec3(target.x, target.y, target.z) } as Parameters<Movements["exclusionBreak"]>[0];
  assert.equal(movements.exclusionBreak(targetBlock), 100);
  assert.equal(movements.exclusionBreak({ position: targetBlock.position.offset(1, 0, 0) } as typeof targetBlock), 0);
  assert.ok(movements.blocksCantBreak.has(bot.registry.blocksByName.crafting_table!.id));
});

test("goto can finish while swimming without waiting for solid ground", async () => {
  const { context, emitter, entity } = createHarness((goal) => {
    entity.position = new Vec3(2.5, -60, 0.5);
    entity.onGround = false;
    entity.isInWater = true;
    emitter.emit("goal_reached", goal);
  });
  const result = await new GotoCapability().execute({ position: target }, context);
  assert.equal(result.ok, true);
  assert.equal(emitter.listenerCount("physicsTick"), 0);
});

test("goto reports observed terrain changes, excluding unrelated and reverted updates", async () => {
  const { context, emitter, entity } = createHarness((goal) => {
    const leaf = new Vec3(1, -59, 0);
    const scaffold = new Vec3(2, -61, 0);
    emitter.emit("path_update", { status: "success", time: 1, visitedNodes: 1, generatedNodes: 1, path: [{
      x: 2, y: -60, z: 0, toBreak: [leaf], toPlace: [{ x: 2, y: -62, z: 0, dx: 0, dy: 1, dz: 0 }],
    }] });
    emitter.emit("blockUpdate", { position: leaf, name: "oak_leaves" }, { position: leaf, name: "air" });
    emitter.emit("blockUpdate", { position: scaffold, name: "air" }, { position: scaffold, name: "dirt" });
    emitter.emit("blockUpdate", { position: new Vec3(9, -60, 0), name: "oak_log" }, { position: new Vec3(9, -60, 0), name: "air" });
    // The server restores the leaf: do not report it as removed.
    emitter.emit("blockUpdate", { position: leaf, name: "air" }, { position: leaf, name: "oak_leaves" });
    entity.position = new Vec3(2.5, -60, 0.5);
    emitter.emit("goal_reached", goal);
  });
  const result = await new GotoCapability().execute({ position: target }, context);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.observedBlockChanges, [{ position: { x: 2, y: -61, z: 0 }, before: "air", after: "dirt" }]);
});

function createHarness(
  onSetGoal: (goal: unknown) => void,
): {
  bot: Bot;
  context: ExecutionContext;
  emitter: EventEmitter;
  entity: { position: Vec3; onGround: boolean; isInWater: boolean };
  calls: { setGoal: number; blockReads: number; clearGoal: number; stop: number };
  items: { type: number; count: number }[];
} {
  const emitter = new EventEmitter();
  const entity = { position: new Vec3(0, -60, 0), onGround: true, isInWater: false };
  const calls = { setGoal: 0, blockReads: 0, clearGoal: 0, stop: 0 };
  const items: { type: number; count: number }[] = [];
  const registry = minecraftData("1.21.11");
  let pendingStop = false;
  const targetBlock = { name: "oak_log", stateId: registry.blocksByName.oak_log!.minStateId, boundingBox: "block", position: new Vec3(target.x, target.y, target.z) };
  const bot = Object.assign(emitter, {
    entity,
    registry,
    inventory: { items: () => items },
    blockAt: (position: Position) => position.x === target.x && position.y === target.y && position.z === target.z
      ? targetBlock : { name: "air", stateId: 0, boundingBox: "empty", position },
    world: { getColumnAt: () => ({}), raycast: () => targetBlock },
    pathfinder: {
      thinkTimeout: 5_000,
      goal: null as unknown,
      movements: null as unknown as Movements,
      setMovements: (movements: Movements) => { bot.pathfinder.movements = movements; },
      setGoal: (goal: unknown) => {
        bot.pathfinder.goal = goal;
        emitter.emit("goal_updated", goal);
        if (pendingStop) {
          pendingStop = false;
          bot.pathfinder.goal = null;
          emitter.emit("path_stop");
          return;
        }
        if (goal === null) { calls.clearGoal += 1; return; }
        calls.setGoal += 1;
        onSetGoal(goal);
      },
      stop: () => { calls.stop += 1; pendingStop = true; },
    },
  });
  bot.pathfinder.movements = new Movements(bot as unknown as Bot);
  const world = {
    getBlock: (position: Position) => {
      calls.blockReads += 1;
      const name =
        position.y === -61
          ? "grass_block"
          : position.y === -60 &&
              position.x === target.x &&
              position.z === target.z
            ? "oak_log"
            : "air";
      return { name };
    },
  } as WorldQueries;
  const context: ExecutionContext = {
    runtime: { bot } as unknown as MinecraftRuntime,
    world,
    signal: new AbortController().signal,
    deferCancellationUntil: () => undefined,
  };
  return { bot: bot as unknown as Bot, context, emitter, entity, calls, items };
}
