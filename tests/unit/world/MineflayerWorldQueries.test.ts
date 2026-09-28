import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import { cardinalFacing, MineflayerWorldQueries } from "../../../src/world/MineflayerWorldQueries";

test("cardinal facing follows Mineflayer's yaw convention", () => {
  assert.equal(cardinalFacing(0), "north");
  assert.equal(cardinalFacing(Math.PI / 2), "west");
  assert.equal(cardinalFacing(-Math.PI / 2), "east");
  assert.equal(cardinalFacing(Math.PI), "south");
});

test("nearby dropped items include their stack identity and count", () => {
  const self = entity(1, "player", new Vec3(0, 64, 0));
  const drop = entity(2, "item", new Vec3(1, 64, 2), () => ({
    name: "oak_log",
    displayName: "Oak Log",
    count: 3,
  }));
  const zombie = entity(3, "zombie", new Vec3(2, 64, 0));
  const world = worldQueries(self, drop, zombie);

  assert.deepEqual(world.getNearbyEntities({ type: "item" }), [
    {
      id: 2,
      name: "item",
      type: "other",
      username: null,
      position: { x: 1, y: 64, z: 2 },
      distance: Math.sqrt(5),
      droppedItem: {
        name: "oak_log",
        displayName: "Oak Log",
        count: 3,
      },
    },
  ]);
  assert.equal(world.getNearbyEntities().find((entry) => entry.id === 3)?.droppedItem, null);
});

test("item entities without metadata remain visible with an unknown stack", () => {
  const self = entity(1, "player", new Vec3(0, 64, 0));
  const drop = entity(2, "item", new Vec3(1, 64, 0), () => {
    throw new TypeError("item metadata not available yet");
  });
  const world = worldQueries(self, drop);

  assert.equal(world.getNearbyEntities()[0]?.droppedItem, null);
});

function entity(
  id: number,
  name: string,
  position: Vec3,
  getDroppedItem?: () => { name: string; displayName: string; count: number },
): Entity {
  return {
    id,
    name,
    type: name === "item" ? "other" : "mob",
    username: null,
    position,
    getDroppedItem,
  } as unknown as Entity;
}

function worldQueries(...entities: Entity[]): MineflayerWorldQueries {
  const bot = {
    entity: entities[0],
    entities: Object.fromEntries(entities.map((entry) => [entry.id, entry])),
  } as unknown as Bot;
  return new MineflayerWorldQueries({ bot } as MinecraftRuntime);
}
