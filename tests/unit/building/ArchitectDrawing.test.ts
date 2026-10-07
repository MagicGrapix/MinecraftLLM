import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { parseArchitectDrawing } from "../../../src/building/ArchitectDrawing";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { architectDrawingFixture } from "../../support/blueprints";

test("one 3x3 floor is one layer and nine planks; a shelter remains the existing Blueprint format", async () => {
  const floor = parseArchitectDrawing("AAA\nAAA\nAAA");
  assert.ok(floor.ok);
  assert.deepEqual(floor.value.layers, [["AAA", "AAA", "AAA"]]);
  const shelter = parseArchitectDrawing((await architectDrawingFixture()).drawing);
  assert.ok(shelter.ok);
  assert.deepEqual(shelter.value.dependencies, { doors: [] });
  const validator = new BlueprintValidator(new MaterialCatalog(minecraftData("1.21.11")));
  for (const [blueprint, count] of [[floor.value, 9], [shelter.value, 80]] as const) {
    const result = validator.validate(blueprint);
    assert.ok(result.ok);
    assert.deepEqual(result.value.materials, [{ item: "oak_planks", quantity: count }]);
  }
});

test("line endings and blank separators normalize, but rows are never silently repaired", () => {
  const result = parseArchitectDrawing("\r\nAA\r\nAA\r\n \t\r\n\r\nA.\r\nAA\r\n");
  assert.ok(result.ok);
  assert.deepEqual(result.value.layers, [["AA", "AA"], ["A.", "AA"]]);
  for (const drawing of ["AA\nA", "AA\nAA\n\nAA", " A", "A ", "B", "_", "Layer 0:\nA", "```\nA\n```", "...", " \n "]) {
    const bad = parseArchitectDrawing(drawing);
    assert.ok(!bad.ok, drawing);
    assert.equal(bad.error.facts?.reason, "INVALID_BLUEPRINT");
  }
  const badRow = parseArchitectDrawing("AAA\nAA");
  assert.ok(!badRow.ok);
  assert.match(badRow.error.message, /Layer 1, row 2.*2 characters; expected 3/);
  const badLayer = parseArchitectDrawing("AA\nAA\n\nAA");
  assert.ok(!badLayer.ok);
  assert.match(badLayer.error.message, /Layer 2 has 1 rows; expected 2/);
});

test("maximum 8x8x5 is accepted; oversized and empty drawings are rejected", () => {
  const layer = Array(8).fill("AAAAAAAA").join("\n");
  assert.ok(parseArchitectDrawing(Array(5).fill(layer).join("\n\n")).ok);
  for (const drawing of ["", "A".repeat(2049), "AAAAAAAAA", Array(9).fill("A").join("\n"), Array(6).fill("A").join("\n\n")]) {
    assert.equal(parseArchitectDrawing(drawing).ok, false);
  }
});
