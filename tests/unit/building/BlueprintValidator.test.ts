import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { BlueprintSchema, type BlueprintIssue } from "../../../src/building/Blueprint";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { BLUEPRINT_LIMITS } from "../../../src/building/BuildingConfig";
import type { TaskResult } from "../../../src/execution/TaskResult";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { blueprintFixture } from "../../support/blueprints";

const registry = minecraftData("1.21.11");
const validator = new BlueprintValidator(new MaterialCatalog(registry));

test("reference shelter compiles to 80 placements and the exact bill of materials", async () => {
  const blueprint = await blueprintFixture();
  const result = validator.validate(blueprint);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.minecraftVersion, "1.21.11");
  assert.equal(result.value.height, 4);
  assert.equal(result.value.cells.length, 100);
  assert.equal(result.value.operations.length, 80);
  assert.equal(result.value.cells.filter((cell) => cell.kind === "air").length, 20);
  assert.deepEqual(result.value.materials, [{ item: "cobblestone", quantity: 25 }, { item: "oak_planks", quantity: 55 }]);
  assert.deepEqual(blueprint, await blueprintFixture());
});

test("local axes are layers[y][z][x], with different meanings for air and ignored cells", () => {
  const result = validator.validate({ name: "axes", description: "", width: 3, depth: 2,
    palette: { A: "oak_planks", B: "cobblestone" },
    layers: [["A.B", "_AA"], ["B__", "..A"]], dependencies: { doors: [] } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.cells[2], { position: { x: 2, y: 0, z: 0 }, kind: "block", block: "cobblestone" });
  assert.deepEqual(result.value.cells[3], { position: { x: 0, y: 0, z: 1 }, kind: "ignore" });
  assert.deepEqual(result.value.cells[9], { position: { x: 0, y: 1, z: 1 }, kind: "air" });
  assert.deepEqual(result.value.operations.at(-1)?.position, { x: 2, y: 1, z: 1 });
  assert.equal(result.value.operations.length, 6);
});

test("palette aliases and namespaces aggregate the same item without modifying the input", async () => {
  const blueprint = await blueprintFixture();
  blueprint.palette.B = "minecraft:oak_planks";
  const result = validator.validate(blueprint);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.materials, [{ item: "oak_planks", quantity: 80 }]);
  assert.equal(result.value.blueprint.palette.B, "oak_planks");
  assert.equal(blueprint.palette.B, "minecraft:oak_planks");
});

for (const patch of [
  { width: 0 }, { width: 9 }, { depth: 9 }, { width: "5" }, { height: 4 },
  { layers: [] }, { layers: Array.from({ length: 6 }, () => ["A"]) },
  { layers: [["A "]] }, { layers: [["a"]] }, { layers: [["😀"]] },
  { palette: {} }, { palette: { AA: "oak_planks" } }, { palette: { ".": "oak_planks" } },
  { palette: { A: "oak_planks,cobblestone" } },
]) {
  test(`blueprint schema rejects malformed input ${JSON.stringify(patch)}`, async () => {
    const result = validator.validate({ ...await blueprintFixture(), ...patch });
    assert.ok(issues(result).some((issue) => issue.code === "INVALID_SHAPE"));
  });
}

test("each row and layer is checked against declared dimensions", async () => {
  const blueprint = await blueprintFixture();
  blueprint.layers[0]!.pop();
  blueprint.layers[1]![0] = "AAAA";
  const feedback = issues(validator.validate(blueprint));
  assert.ok(feedback.some((issue) => issue.path === "layers.0" && issue.received === 4));
  assert.ok(feedback.some((issue) => issue.path === "layers.1.0" && issue.received === 4));
});

test("missing palette symbols report exact local coordinates", async () => {
  const blueprint = await blueprintFixture();
  blueprint.layers[1]![0] = "AACAA";
  const feedback = issues(validator.validate(blueprint));
  assert.deepEqual(feedback.find((issue) => issue.code === "UNKNOWN_SYMBOL")?.position, { x: 2, y: 1, z: 0 });
  assert.equal(feedback.find((issue) => issue.code === "UNKNOWN_SYMBOL")?.path, "layers.1.0.2");
});

test("unknown block names return suggestions but never an accepted substituted blueprint", async () => {
  const blueprint = await blueprintFixture();
  blueprint.palette.A = "oak_plate";
  const feedback = issues(validator.validate(blueprint));
  assert.equal(feedback[0]?.code, "UNKNOWN_BLOCK");
  assert.equal(feedback[0]?.path, "palette.A");
  assert.ok(feedback[0]?.suggestions?.includes("oak_planks"));
  assert.equal(blueprint.palette.A, "oak_plate");
});

test("known stateful or falling blocks are rejected separately from unknown IDs", async () => {
  for (const name of ["oak_log", "sand", "oak_door", "oak_stairs", "water", "grass_block"]) {
    const blueprint = await blueprintFixture();
    blueprint.palette.A = name;
    assert.ok(issues(validator.validate(blueprint)).some((issue) => issue.code === "UNSUPPORTED_BLOCK"), name);
  }
});

test("a known supported block still needs a matching placement item in this version", async () => {
  const itemsByName = { ...registry.itemsByName };
  delete itemsByName.oak_planks;
  const missingItemValidator = new BlueprintValidator(new MaterialCatalog({ ...registry, itemsByName }));
  assert.ok(issues(missingItemValidator.validate(await blueprintFixture()))
    .some((issue) => issue.code === "MISSING_PLACEMENT_ITEM"));
});

test("door fixture reserves the format but is never accepted before door placement exists", async () => {
  const house = await blueprintFixture(true);
  assert.equal(BlueprintSchema.safeParse(house).success, true);
  const feedback = issues(validator.validate(house));
  assert.equal(feedback[0]?.code, "UNSUPPORTED_DEPENDENCY");
  assert.equal(feedback[0]?.path, "dependencies.doors.0");
});

test("dependency positions and orientation have strict schemas", async () => {
  const house = await blueprintFixture(true);
  const door = house.dependencies.doors[0]!;
  assert.equal(BlueprintSchema.safeParse({ ...house, dependencies: { doors: [{ ...door, position: { x: -1, y: 1, z: 0 } }] } }).success, false);
  assert.equal(BlueprintSchema.safeParse({ ...house, dependencies: { doors: [{ ...door, facing: "up" }] } }).success, false);
});

test("an air-only drawing is not a construction", () => {
  const result = validator.validate({ name: "empty", description: "", width: 2, depth: 1,
    palette: { A: "stone" }, layers: [["._"]], dependencies: { doors: [] } });
  assert.ok(issues(result).some((issue) => issue.code === "EMPTY_BLUEPRINT"));
});

test("the maximum 8x8x5 volume works and feedback remains bounded", () => {
  const blueprint = { name: "max", description: "", width: 8, depth: 8,
    palette: { A: "stone" }, layers: Array.from({ length: 5 }, () => Array(8).fill("AAAAAAAA")), dependencies: { doors: [] } };
  const accepted = validator.validate(blueprint);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.value.materials, [{ item: "stone", quantity: 320 }]);
  const rejected = validator.validate({ ...blueprint, layers: Array.from({ length: 5 }, () => Array(8).fill("ZZZZZZZZ")) });
  assert.equal(issues(rejected).length, BLUEPRINT_LIMITS.maxIssues);
  if (!rejected.ok) assert.ok(Number(rejected.error.facts?.totalIssues) >= 320);
});

test("oversized rejected values are not copied wholesale into feedback", async () => {
  const rejected = validator.validate({ ...await blueprintFixture(), name: "x".repeat(100_000) });
  assert.ok(JSON.stringify(rejected).length < 1_000);
});

test("oversized field names cannot inflate schema feedback paths or messages", async () => {
  const blueprint = await blueprintFixture();
  const field = "x".repeat(100_000);
  for (const raw of [{ ...blueprint, [field]: true }, { ...blueprint, palette: { [field]: "stone" } }]) {
    const rejected = validator.validate(raw);
    assert.equal(rejected.ok, false);
    assert.ok(JSON.stringify(rejected).length < 1_500);
  }
});

test("non-JSON scalar mistakes still produce serializable feedback", async () => {
  const rejected = validator.validate({ ...await blueprintFixture(), width: 5n });
  assert.equal(rejected.ok, false);
  assert.doesNotThrow(() => JSON.stringify(rejected));
});

function issues(result: TaskResult<unknown>): readonly BlueprintIssue[] {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected rejection");
  assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal(result.error.facts?.reason, "INVALID_BLUEPRINT");
  return result.error.facts?.issues as BlueprintIssue[];
}
