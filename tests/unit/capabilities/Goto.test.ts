import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { GotoCapability } from "../../../src/capabilities/Goto";
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
  assert.equal(result.error.code, "NO_PATH");
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
    assert.equal(result.error.code, "NO_PATH");
    assert.equal(result.error.facts?.reason, "goal_not_reached");
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

function createHarness(
  onSetGoal: (goal: unknown) => void,
): {
  bot: Bot;
  context: ExecutionContext;
  emitter: EventEmitter;
  entity: { position: Vec3 };
  calls: { setGoal: number; blockReads: number };
} {
  const emitter = new EventEmitter();
  const entity = { position: new Vec3(0, -60, 0) };
  const calls = { setGoal: 0, blockReads: 0 };
  const bot = Object.assign(emitter, {
    entity,
    world: { getColumnAt: () => ({}) },
    pathfinder: {
      thinkTimeout: 5_000,
      setGoal: (goal: unknown) => {
        calls.setGoal += 1;
        onSetGoal(goal);
      },
      stop: () => emitter.emit("path_stop"),
    },
  }) as unknown as Bot;
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
    runtime: { bot } as MinecraftRuntime,
    world,
    signal: new AbortController().signal,
    deferCancellationUntil: () => undefined,
  };
  return { bot, context, emitter, entity, calls };
}
