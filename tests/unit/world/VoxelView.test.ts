import assert from "node:assert/strict";
import test from "node:test";
import type { Position } from "../../../src/shared/types";
import { buildVoxelView } from "../../../src/world/VoxelView";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import type { BlockInfo } from "../../../src/world/types";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";

test("voxel view is north-up and resolves a focused cell to world coordinates", () => {
  const sampled: Position[] = [];
  const world = fakeWorld((position) => {
    sampled.push(position);
    if (position.x === 3 && position.y === -61 && position.z === 6) {
      return null;
    }
    const name = position.x === 5 && position.y === -60 && position.z === 7
      ? "oak_log"
      : position.x === 7 && position.y === -60 && position.z === 8
        ? "stone"
        : position.y === -61 ? "dirt" : "air";
    return block(name, position);
  });

  const view = buildVoxelView(world, {
    center: { kind: "self" },
    focus: { dx: 0, dy: 0, dz: -1 },
  });

  assert.deepEqual(view.center, { x: 5, y: -60, z: 8 });
  assert.deepEqual(view.bot.offset, { dx: 0, dy: 0, dz: 0 });
  assert.equal(view.bot.facing, "north");
  assert.deepEqual(view.xOffsets, [-2, -1, 0, 1, 2]);
  assert.deepEqual(view.zOffsets, [-2, -1, 0, 1, 2]);
  assert.equal(view.layers.length, 4);
  assert.equal(view.layers[0]?.rows[0], "? D D D D");
  assert.equal(view.layers[1]?.rows[1], ". . L . .");
  assert.equal(view.layers[1]?.rows[2], ". . . . S");
  assert.deepEqual(view.focus, {
    offset: { dx: 0, dy: 0, dz: -1 },
    position: { x: 5, y: -60, z: 7 },
    symbol: "L",
    block: { name: "oak_log", boundingBox: "block" },
  });
  assert.equal(view.legend["?"], "unknown/unloaded");
  assert.equal(view.legend.L, "oak_log");
  assert.equal(sampled.length, 100);
});

test("explicit position centers the same fixed grid without moving the bot", () => {
  const world = fakeWorld((position) => block("air", position));
  const view = buildVoxelView(world, {
    center: { kind: "position", position: { x: 10, y: -58, z: 11 } },
    focus: { dx: -2, dy: 2, dz: 2 },
  });

  assert.deepEqual(view.center, { x: 10, y: -58, z: 11 });
  assert.deepEqual(view.bot.offset, { dx: -5, dy: -2, dz: -3 });
  assert.deepEqual(view.focus?.position, { x: 8, y: -56, z: 13 });
  assert.equal(view.layers[3]?.y, -56);
  assert.equal(view.layers[3]?.rows[4], ". . . . .");
});

test("voxel query rejects invalid offsets and distant centers", async () => {
  const registry = createDefaultWorldQueryRegistry(fakeWorld((position) => block("air", position)));

  const invalidFocus = await registry.execute("get_voxel_view", {
    center: { kind: "self" },
    focus: { dx: 3, dy: 0, dz: 0 },
  });
  const distantCenter = await registry.execute("get_voxel_view", {
    center: { kind: "position", position: { x: 100, y: -60, z: 8 } },
  });
  const valid = await registry.execute("get_voxel_view", {
    center: { kind: "self" },
  });

  assert.equal(invalidFocus.ok, false);
  if (!invalidFocus.ok) assert.equal(invalidFocus.error.code, "INVALID_ARGUMENT");
  assert.equal(distantCenter.ok, false);
  if (!distantCenter.ok) assert.equal(distantCenter.error.code, "INVALID_ARGUMENT");
  assert.equal(valid.ok, true);
});

function fakeWorld(getBlock: (position: Position) => BlockInfo | null): WorldQueries {
  return {
    isKnownName: () => true,
    getSelf: () => ({
      position: { x: 5.5, y: -60, z: 8.5 },
      facing: "north",
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygenLevel: 20,
      onGround: true,
    }),
    getInventory: () => ({ items: [], selectedItem: null }),
    getBlock,
    getBlockAccess: () => { throw new Error("Block access was not stubbed."); },
    findNearestBlocks: async () => [],
    getNearbyEntities: () => [],
  };
}

function block(name: string, position: Position): BlockInfo {
  return {
    name,
    displayName: name,
    type: 0,
    position,
    boundingBox: name === "air" ? "empty" : "block",
  };
}
