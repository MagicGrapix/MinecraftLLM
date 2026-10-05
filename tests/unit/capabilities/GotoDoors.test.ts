import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import type { Block as BlockType } from "prismarine-block";
import { Vec3 } from "vec3";
import { createGotoMovements } from "../../../src/capabilities/GotoMovements";
import { correctOpenDoorWaypoints } from "../../../src/capabilities/GotoDoors";
import type { PartiallyComputedPath } from "mineflayer-pathfinder";

const registry = minecraftData("1.21.11");
const Block = require("prismarine-block")(registry) as typeof BlockType;
test("door waypoints are brought back to feet level without modifying unrelated path nodes", () => {
  const floor = Block.fromProperties("stone", {}, 0);
  const lower = Block.fromProperties("oak_door", { facing: "north", hinge: "left", half: "lower", open: "true", powered: "false" }, 0);
  const upper = Block.fromProperties("oak_door", { facing: "north", hinge: "left", half: "upper", open: "true", powered: "false" }, 0);
  const bot = { blockAt: (p: Vec3) => p.x || p.z ? null : p.y === 1 ? upper : p.y === 0 ? lower : floor } as unknown as Bot;
  const point = { x: 0.7, y: 1, z: 0.5, toBreak: [], toPlace: [] };
  const outside = { x: 2.5, y: 0, z: 0.5, toBreak: [], toPlace: [] };
  const update = { status: "success", path: [point, outside] } as unknown as PartiallyComputedPath;
  correctOpenDoorWaypoints(bot, update);
  assert.deepEqual(point, { x: 0.5, y: 0, z: 0.5, toBreak: [], toPlace: [] });
  assert.deepEqual(outside, { x: 2.5, y: 0, z: 0.5, toBreak: [], toPlace: [] });
  correctOpenDoorWaypoints(bot, update); assert.equal(point.y, 0, "Correction is idempotent");
});
test("goto admits an already-open door for every facing/hinge/half without mutating collision shapes", () => {
  for (const facing of ["north", "south", "east", "west"]) for (const hinge of ["left", "right"]) for (const half of ["lower", "upper"]) {
    const block = Block.fromProperties("oak_door", { facing, hinge, half, open: "true", powered: "false" }, 0);
    block.position = new Vec3(0, 0, 0);
    const shapes = structuredClone(block.shapes), stateId = block.stateId;
    const bot = { registry, blockAt: () => block } as unknown as Bot;
    const movements = createGotoMovements(bot, new Vec3(0, 0, 2), { canDig: false, canPlace: false });
    const observed = movements.getBlock(new Vec3(0, 0, 0), 0, 0, 0);
    assert.equal(observed.safe, true); assert.equal(observed.physical, false); assert.equal(observed.replaceable, false);
    assert.equal(observed.openable, false); assert.equal(observed.height, 0);
    assert.notEqual(observed, block); assert.deepEqual(block.shapes, shapes); assert.equal(block.stateId, stateId); assert.equal(block.boundingBox, "block");
    movements.blocksToAvoid.add(block.type);
    assert.equal(movements.getBlock(new Vec3(0, 0, 0), 0, 0, 0).safe, false);
  }
});
test("closed doors, unknown cells and obstructing shapes stay blocked", () => {
  let block: BlockType | null = Block.fromProperties("oak_door", { facing: "north", hinge: "left", half: "lower", open: "false", powered: "false" }, 0);
  block.position = new Vec3(0, 0, 0);
  const bot = { registry, blockAt: () => block } as unknown as Bot;
  const movements = createGotoMovements(bot, new Vec3(0, 0, 2), { canDig: false, canPlace: false });
  assert.equal(movements.getBlock(new Vec3(0, 0, 0), 0, 0, 0).safe, false);
  block = Block.fromProperties("oak_door", { facing: "north", hinge: "left", half: "lower", open: "true", powered: "false" }, 0);
  block.position = new Vec3(0, 0, 0); block.shapes = [[0, 0, 0, 1, 1, 1]];
  assert.equal(movements.getBlock(new Vec3(0, 0, 0), 0, 0, 0).safe, false);
  block = null; assert.equal(movements.getBlock(new Vec3(0, 0, 0), 0, 0, 0).safe, false);
});
