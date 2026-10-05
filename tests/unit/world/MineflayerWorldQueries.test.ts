import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import { cardinalFacing, MineflayerWorldQueries } from "../../../src/world/MineflayerWorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";

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

test("dropped-items tool projects real adapter metadata while keeping generic discovery internal", async () => {
  const self = entity(1, "player", new Vec3(0, 64, 0));
  const known = entity(2, "item", new Vec3(2, 64, 0), () => ({
    name: "oak_log", displayName: "Oak Log", count: 3,
  }));
  const unknown = entity(3, "item", new Vec3(1, 64, 0), () => { throw new Error("Metadata pending."); });
  const zombie = entity(4, "zombie", new Vec3(1, 64, 1));
  const world = worldQueries(self, known, unknown, zombie);
  const registry = createDefaultWorldQueryRegistry(world);
  assert.deepEqual(await registry.execute("get_dropped_items", { maxDistance: 10 }), {
    ok: true, value: [
      { id: 3, item: null, count: null, position: { x: 1, y: 64, z: 0 }, distance: 1 },
      { id: 2, item: "oak_log", count: 3, position: { x: 2, y: 64, z: 0 }, distance: 2 },
    ],
  });
  assert.equal(registry.has("get_nearby_entities"), false);
  assert.ok(world.getNearbyEntities().some((entity) => entity.name === "zombie"));
});

test("item entities without metadata remain visible with an unknown stack", () => {
  const self = entity(1, "player", new Vec3(0, 64, 0));
  const drop = entity(2, "item", new Vec3(1, 64, 0), () => {
    throw new TypeError("item metadata not available yet");
  });
  const world = worldQueries(self, drop);

  assert.equal(world.getNearbyEntities()[0]?.droppedItem, null);
});

test("search validation uses the connected version registries and rejects partially unknown lists", async () => {
  let searches = 0;
  const bot = {
    entity: { id: 1, position: new Vec3(0, -60, 0) }, entities: {},
    registry: { blocksByName: { oak_log: { id: 1 } }, itemsByName: { oak_log: { id: 2 }, stick: { id: 3 } } },
    game: { dimension: "overworld", minY: -64, height: 384 },
    world: { getColumn: () => ({}) },
    blockAt: () => { searches += 1; return null; },
  } as unknown as Bot;
  const world = new MineflayerWorldQueries({ bot } as MinecraftRuntime);
  const registry = createDefaultWorldQueryRegistry(world);
  assert.equal(world.isKnownName("block", "minecraft:oak_log"), true);
  assert.equal(world.isKnownName("block", "stick"), false);
  assert.equal(world.isKnownName("item", "stick"), true);
  assert.equal(world.isKnownName("item", "toString"), false);
  for (const query of ["find_nearest_blocks", "get_dropped_items"]) {
    const result = await registry.execute(query, { names: ["oak_log", "log"] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.error.facts?.unknownNames, ["log"]);
  }
  assert.equal(searches, 0);
  await assert.rejects(world.findNearestBlocks(["oak_log", "log"]), /Unknown block/);
  assert.equal(searches, 0);
  assert.deepEqual(await registry.execute("find_nearest_blocks", { names: ["minecraft:oak_log"] }), { ok: true, value: [] });
  assert.ok(searches > 0);
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
