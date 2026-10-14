import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { Builder } from "../../../src/building/Builder";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import type { Blueprint } from "../../../src/building/Blueprint";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { failure } from "../../../src/execution/TaskResult";
import { ToolCallJournal, formatInventoryDiff } from "../../../src/execution/ToolCallJournal";
import { TestBuildOperations } from "../../support/building";
import { blueprintFixture } from "../../support/blueprints";

const validator = new BlueprintValidator(new MaterialCatalog(minecraftData("1.21.11")));
const input = { blueprintId: "bp_00000000-0000-0000-0000-000000000001", origin: { x: 0, y: 0, z: 0 } };
const simple: Blueprint = { name: "two", description: "", width: 3, depth: 1, palette: { A: "oak_planks" }, layers: [["AA."]], dependencies: { doors: [] } };
function compile(blueprint = simple) { const result = validator.validate(blueprint); assert.ok(result.ok); return result.value; }
function run(ops: TestBuildOperations, blueprint = simple, signal = new AbortController().signal) {
  return new Builder(ops).build(compile(blueprint), input, { signal });
}

test("build places cubes, validates required air, and resumes without consuming another item", async () => {
  const ops = new TestBuildOperations();
  const result = await run(ops); assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.placedThisCall, 2); assert.equal(result.value.remaining, 0);
  assert.equal(ops.stock.get("oak_planks"), 53);
  const resumed = await run(ops); assert.ok(resumed.ok);
  assert.equal(resumed.value.placedThisCall, 0); assert.equal(resumed.value.alreadyCorrect, 2);
  assert.equal(ops.stock.get("oak_planks"), 53);
});

test("5x5 shelter geometry, exact materials and one aggregate inventory action", async () => {
  const ops = new TestBuildOperations();
  const journal = new ToolCallJournal(() => Object.fromEntries(ops.stock));
  const n = journal.start("build", true);
  const result = await run(ops, await blueprintFixture()); journal.complete(n, result.ok);
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.value.correct, 80);
  assert.equal(ops.placements.length, 80);
  assert.match(formatInventoryDiff(journal.get(n)!), /- oak_planks: 55/);
  assert.match(formatInventoryDiff(journal.get(n)!), /- cobblestone: 25/);
  assert.equal(journal.get(n + 1), undefined);
  assert.ok(ops.feet.x < 0 || ops.feet.x >= 5 || ops.feet.z < 0 || ops.feet.z >= 5);
});

for (const [label, setup, code] of [
  ["missing materials", (o: TestBuildOperations) => o.stock.clear(), "MISSING_ITEM"],
  ["wrong block", (o: TestBuildOperations) => o.set(input.origin, "stone"), "BLOCKED"],
  ["required air occupied", (o: TestBuildOperations) => o.set({ x: 2, y: 0, z: 0 }, "stone"), "BLOCKED"],
  ["water is not air", (o: TestBuildOperations) => o.set(input.origin, "water"), "BLOCKED"],
  ["unknown target", (o: TestBuildOperations) => o.set(input.origin, null), "WORLD_CHANGED"],
  ["unknown support", (o: TestBuildOperations) => o.set({ x: -2, y: -1, z: -2 }, null), "BLOCKED"],
  ["too far away", (o: TestBuildOperations) => { o.feet = new Vec3(60, 0, 0); }, "INVALID_ARGUMENT"],
  ["world height", (o: TestBuildOperations) => { o.maxY = 1; }, "INVALID_ARGUMENT"],
  ["unknown world height", (o: TestBuildOperations) => { o.minY = NaN; }, "WORLD_CHANGED"],
] as const) test(`preflight rejects ${label} without moving, equipping or placing`, async () => {
  const ops = new TestBuildOperations(); setup(ops);
  const result = await run(ops); assert.ok(!result.ok); assert.equal(result.error.code, code);
  assert.equal(ops.moves.length, 0); assert.equal(ops.placements.length, 0);
});

test("ignored cells are not cleared or required to be air", async () => {
  const ops = new TestBuildOperations(); ops.set({ x: 2, y: 0, z: 0 }, "stone");
  const result = await run(ops, { ...simple, layers: [["AA_"]] });
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(ops.blockAt({ x: 2, y: 0, z: 0 })!.name, "stone");
});

test("no reachable stance tries at most 8 moves and never places blindly", async () => {
  const ops = new TestBuildOperations(); ops.feet = new Vec3(-10, 0, -10);
  ops.onMove = async () => failure("NO_PATH", "Blocked in test");
  const result = await run(ops); assert.ok(!result.ok); assert.equal(result.error.code, "NO_PATH");
  assert.ok(ops.moves.length > 0 && ops.moves.length <= 8); assert.equal(ops.placements.length, 0);
});

test("uncertain placement stops, preserves partial progress, and a new call reobserves it", async () => {
  const ops = new TestBuildOperations();
  ops.onPlace = async () => ops.placements.length ? failure("ACTION_NOT_CONFIRMED", "No ACK") : { ok: true, value: {} };
  const result = await run(ops); assert.ok(!result.ok); assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
  assert.equal(ops.placements.length, 1);
  assert.equal((result.error.facts!.progress as { placedThisCall: number }).placedThisCall, 1);
  ops.onPlace = undefined;
  const resumed = await run(ops); assert.ok(resumed.ok); assert.equal(resumed.value.placedThisCall, 1);
});

test("a local pathfinder timeout tries another work position, not a second build call", async () => {
  const ops = new TestBuildOperations(); ops.feet = new Vec3(-10, 0, -10);
  ops.onMove = async () => ops.moves.length === 1
    ? failure("TIMEOUT", "Path search budget", { facts: { reason: "Timeout" } })
    : { ok: true, value: {} };
  const result = await run(ops); assert.ok(result.ok, JSON.stringify(result));
  assert.ok(ops.moves.length >= 2); assert.equal(ops.placements.length, 2);
});

test("unknown timeouts and action cancellation never fall through to another position", async () => {
  for (const cancel of [false, true]) {
    const ops = new TestBuildOperations(), controller = new AbortController();
    ops.feet = new Vec3(-10, 0, -10);
    ops.onMove = async () => {
      if (cancel) controller.abort(new Error("action deadline"));
      return failure("TIMEOUT", "Deadline", cancel ? { facts: { reason: "Timeout" } } : {});
    };
    if (cancel) await assert.rejects(run(ops, simple, controller.signal), /action deadline/);
    else { const result = await run(ops); assert.ok(!result.ok && result.error.code === "TIMEOUT"); }
    assert.equal(ops.moves.length, 1); assert.equal(ops.placements.length, 0);
  }
});

test("stop after an in-flight placement never starts the following placement", async () => {
  const ops = new TestBuildOperations(), controller = new AbortController();
  ops.onPlace = async () => { controller.abort(new Error("stop")); return { ok: true, value: {} }; };
  await assert.rejects(run(ops, simple, controller.signal), /stop/);
  assert.equal(ops.placements.length, 1);
});

test("a dimension change during a move prevents placement", async () => {
  const ops = new TestBuildOperations(); ops.feet = new Vec3(-10, 0, -10);
  ops.onMove = async () => { ops.dimension = "the_nether"; return { ok: true, value: {} }; };
  const result = await run(ops); assert.ok(!result.ok); assert.equal(result.error.code, "WORLD_CHANGED");
  assert.equal(ops.placements.length, 0);
});

test("a dimension change during placement stops before the next move or placement", async () => {
  const ops = new TestBuildOperations();
  ops.onPlace = async () => { ops.dimension = "the_nether"; return { ok: true, value: {} }; };
  const result = await run(ops); assert.ok(!result.ok); assert.equal(result.error.code, "WORLD_CHANGED");
  assert.equal(ops.placements.length, 1); assert.equal(ops.moves.length, 0);
});

test("final verification catches a block destroyed after the last placement", async () => {
  const ops = new TestBuildOperations();
  const blueprint = await blueprintFixture();
  const result = await new Builder(ops).build(compile(blueprint), input, {
    signal: new AbortController().signal,
    progress: (p) => { if (p.phase === "verifying") ops.set(input.origin, "air"); },
  });
  assert.ok(!result.ok); assert.equal(result.error.code, "WORLD_CHANGED");
});

test("unsupported floating design reports access failure instead of inventing scaffolding", async () => {
  const ops = new TestBuildOperations();
  const result = await run(ops, { ...simple, width: 1, layers: [["_"], ["_"], ["A"]] });
  assert.ok(!result.ok); assert.equal(result.error.code, "OUT_OF_REACH");
  assert.equal(ops.placements.length, 0);
});
