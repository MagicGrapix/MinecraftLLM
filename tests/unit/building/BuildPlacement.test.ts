import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { canPlaceFrom } from "../../../src/building/BuildPlacement";
import { TestBuildOperations } from "../../support/building";
import { safeExitStances } from "../../../src/building/BuildExit";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import minecraftData from "minecraft-data";
import { blueprintFixture } from "../../support/blueprints";

test("closing the roof rejects a roof stance with no safe way back down", async () => {
  const compiled = new BlueprintValidator(new MaterialCatalog(minecraftData("1.21.11"))).validate(await blueprintFixture());
  assert.ok(compiled.ok);
  const ops = new TestBuildOperations();
  for (const operation of compiled.value.operations) ops.set(operation.position, operation.block);
  const last = { x: 4, y: 3, z: 4 }; ops.set(last, "air");
  const safe = safeExitStances(compiled.value, { x: 0, y: 0, z: 0 }, ops, last);
  assert.equal(safe({ x: 3.5, y: 4, z: 3.5 }), false);
  assert.equal(safe({ x: 2.5, y: 1, z: 2.5 }), true); // Interior exits through the two-cell doorway.
  assert.equal(safe({ x: -1.5, y: 0, z: -1.5 }), true);
});

test("placement geometry requires a visible, in-range safe support face and excludes bot collision", () => {
  const ops = new TestBuildOperations();
  const face = { referencePosition: { x: 0, y: -1, z: 0 }, face: "top" as const };
  assert.ok(canPlaceFrom(ops, face, ops.eyes(), ops.position()));
  ops.feet = new Vec3(0.5, 0, 0.5);
  assert.equal(canPlaceFrom(ops, face, ops.eyes(), ops.position()), false);
  ops.feet = new Vec3(-10, 0, -10);
  assert.equal(canPlaceFrom(ops, face, ops.eyes(), ops.position()), false);
  ops.feet = new Vec3(-1.5, 0, -1.5);
  ops.set({ x: -1, y: 0, z: -1 }, "stone");
  assert.equal(canPlaceFrom(ops, face, ops.eyes(), ops.position()), false);
  ops.set({ x: -1, y: 0, z: -1 }, null);
  assert.equal(canPlaceFrom(ops, face, ops.eyes(), ops.position()), false);
  ops.set({ x: -1, y: 0, z: -1 }, "air");
  ops.set(face.referencePosition, "chest");
  assert.equal(canPlaceFrom(ops, face, ops.eyes(), ops.position()), false);
});
