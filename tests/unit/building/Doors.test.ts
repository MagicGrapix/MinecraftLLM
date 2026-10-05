import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { Builder } from "../../../src/building/Builder";
import { canPlaceDoor } from "../../../src/building/BuildDoor";
import { inspectBuild } from "../../../src/building/BuildVerification";
import { expectedDoorHinge } from "../../../src/building/BlueprintDoors";
import type { DoorFacing } from "../../../src/building/Blueprint";
import { TestBuildOperations } from "../../support/building";
import { blueprintFixture } from "../../support/blueprints";

const validator = new BlueprintValidator(new MaterialCatalog(minecraftData("1.21.11")));
const input = { blueprintId: "test", origin: { x: 0, y: 0, z: 0 } };
const options = () => ({ signal: new AbortController().signal });
for (const facing of ["north", "south", "east", "west"] as DoorFacing[]) {
  test(`door ${facing}: one placement, two cells, idempotent verification`, async () => {
    const result = validator.validate({ name: "door", description: "", width: 1, depth: 1, palette: { A: "stone" },
      layers: [["_"], ["_"]], dependencies: { doors: [{ item: "oak_door", position: input.origin, facing }] } });
    assert.ok(result.ok); const ops = new TestBuildOperations(); ops.stock = new Map([["oak_door", 1]]);
    const builder = new Builder(ops);
    const built = await builder.build(result.value, input, options()); assert.ok(built.ok, JSON.stringify(built));
    assert.equal(built.value.correct, 1); assert.equal(ops.placements.length, 1); assert.equal(ops.stock.get("oak_door"), 0);
    const again = await builder.build(result.value, input, options()); assert.ok(again.ok); assert.equal(again.value.placedThisCall, 0);
    assert.equal(ops.blockAt({ x: 0, y: 1, z: 0 })?.getProperties().facing, facing);
  });
}
test("house builds door last and does not leave the bot sealed inside", async () => {
  const result = validator.validate(await blueprintFixture(true)); assert.ok(result.ok);
  const ops = new TestBuildOperations(); ops.stock.set("oak_door", 1);
  const built = await new Builder(ops).build(result.value, input, options()); assert.ok(built.ok, JSON.stringify(built));
  assert.equal(built.value.correct, 81); assert.equal(ops.placements.length, 81);
  assert.deepEqual(ops.placements.at(-1), { x: 2, y: 1, z: 0 });
  assert.ok(ops.feet.x < 0 || ops.feet.x >= 5 || ops.feet.z < 0 || ops.feet.z >= 5);
  for (const patch of [{ half: "lower" }, { facing: "south" }, { hinge: "right" }, { open: true }, { powered: true }]) {
    const key = ops.key({ x: 2, y: 2, z: 0 }); const original = ops.properties.get(key)!;
    ops.properties.set(key, { ...original, ...patch });
    const conflict = inspectBuild(result.value, input.origin, ops); assert.ok(!conflict.ok);
    assert.equal(conflict.error.facts?.reason, "DOOR_CONFLICT"); ops.properties.set(key, original);
  }
  ops.set({ x: 2, y: 2, z: 0 }, "air");
  const partial = await new Builder(ops).build(result.value, input, options()); assert.ok(!partial.ok);
  assert.equal(partial.error.facts?.reason, "DOOR_CONFLICT"); assert.equal(ops.placements.length, 81);
});
test("missing door item prevents any cube placement", async () => {
  const plan = validator.validate(await blueprintFixture(true)); assert.ok(plan.ok);
  const ops = new TestBuildOperations(); const built = await new Builder(ops).build(plan.value, input, options());
  assert.ok(!built.ok); assert.equal(built.error.code, "MISSING_ITEM"); assert.equal(ops.moves.length, 0); assert.equal(ops.placements.length, 0);
});
test("hinge is computed from side supports; unexpected neighbours block placement", () => {
  const position = { x: 0, y: 0, z: 0 };
  assert.equal(expectedDoorHinge(position, "north", p => p.x === 1), "right");
  assert.equal(expectedDoorHinge(position, "north", p => p.x === -1), "left");
  const ops = new TestBuildOperations();
  const door = { kind: "place_door" as const, position, item: "oak_door", block: "oak_door", facing: "north" as const, hinge: "left" as const };
  assert.equal(canPlaceDoor(ops, door, ops.eyes(), ops.position()), true);
  ops.set({ x: 1, y: 0, z: 0 }, "oak_planks");
  assert.equal(canPlaceDoor(ops, door, ops.eyes(), ops.position()), false);
  ops.set({ x: 1, y: 0, z: 0 }, "oak_door");
  assert.equal(canPlaceDoor(ops, door, ops.eyes(), ops.position()), false);
});
