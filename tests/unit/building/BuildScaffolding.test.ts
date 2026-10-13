import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { Builder } from "../../../src/building/Builder";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import type { Blueprint } from "../../../src/building/Blueprint";
import type { BuildProgress, ScaffoldState } from "../../../src/building/BuildTypes";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { failure } from "../../../src/execution/TaskResult";
import { TestBuildOperations } from "../../support/building";

const validator = new BlueprintValidator(new MaterialCatalog(minecraftData("1.21.11")));
const input = { blueprintId: "bp_00000000-0000-0000-0000-000000000001", origin: { x: 0, y: 0, z: 0 } };
const pillar: Blueprint = { name: "tall_pillar", description: "Requires raised work positions", width: 1, depth: 1,
  palette: { A: "oak_planks" }, layers: [["A"], ["A"], ["A"], ["A"], ["A"]], dependencies: { doors: [] } };
function compile(blueprint = pillar) { const result = validator.validate(blueprint); assert.ok(result.ok); return result.value; }
function setup() { const ops = new TestBuildOperations(); ops.stock = new Map([["oak_planks", 5], ["dirt", 24]]); return ops; }

test("a five-block pillar needs scaffolding, removes only its dirt, and can be called again", async () => {
  const ops = setup(), state: ScaffoldState = [];
  const untouched = { x: 2, y: 0, z: 2 }; ops.set(untouched, "dirt");
  const builder = new Builder(ops, state);
  const result = await builder.build(compile(), input, { signal: new AbortController().signal });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.placedThisCall, 5);
  assert.ok(result.value.scaffolding.placedThisCall > 0);
  assert.equal(result.value.scaffolding.removedThisCall, result.value.scaffolding.placedThisCall);
  assert.deepEqual(state, []);
  assert.ok(ops.removals.every(p => (p.x !== 0 || p.z !== 0) && p.y >= 0 && p.x >= -2 && p.x <= 2 && p.z >= -2 && p.z <= 2));
  assert.equal(ops.blockAt(untouched)?.name, "dirt");
  for (let y = 0; y < 5; y++) assert.equal(ops.blockAt({ x: 0, y, z: 0 })?.name, "oak_planks");
  const resumed = await builder.build(compile(), input, { signal: new AbortController().signal });
  assert.ok(resumed.ok); assert.equal(resumed.value.placedThisCall, 0);
  assert.equal(resumed.value.scaffolding.placedThisCall, 0);
});

test("temporary access never spends dirt reserved for the permanent blueprint", async () => {
  const ops = setup(); ops.stock = new Map([["dirt", 5]]);
  const result = await new Builder(ops).build(compile({ ...pillar, palette: { A: "dirt" } }), input, { signal: new AbortController().signal });
  assert.ok(!result.ok); assert.equal(result.error.code, "MISSING_ITEM");
  assert.equal(result.error.facts?.reason, "MISSING_SCAFFOLD_MATERIALS");
  assert.ok(ops.placements.every(p => p.x === 0 && p.z === 0));
  assert.equal(ops.removals.length, 0);
});

test("stop preserves tracked access for a new Builder on the same job", async () => {
  const ops = setup(), state: ScaffoldState = [], abort = new AbortController();
  let last: BuildProgress | undefined;
  await assert.rejects(new Builder(ops, state).build(compile(), input, {
    signal: abort.signal, progress: p => { last = p; },
    trace: event => { if (event.event === "scaffold_place_confirmed") abort.abort(new Error("stop")); },
  }), /stop/);
  assert.equal(state.length, 1); assert.equal(last?.scaffolding.remaining.length, 1);
  assert.equal(ops.removals.length, 0);
  const resumed = await new Builder(ops, state).build(compile(), input, { signal: new AbortController().signal });
  assert.ok(resumed.ok, JSON.stringify(resumed)); assert.equal(state.length, 0);
});

test("cleanup failure reports remaining dirt, then a retry cleans without rebuilding", async () => {
  const ops = setup(), state: ScaffoldState = [];
  ops.onRemove = async () => failure("BLOCKED", "Dig rejected");
  const failed = await new Builder(ops, state).build(compile(), input, { signal: new AbortController().signal });
  assert.ok(!failed.ok); assert.equal(failed.error.facts?.reason, "SCAFFOLD_CLEANUP_INCOMPLETE");
  assert.equal((failed.error.facts?.progress as BuildProgress).remaining, 0);
  assert.ok(state.length > 0);
  ops.onRemove = undefined;
  const retried = await new Builder(ops, state).build(compile(), input, { signal: new AbortController().signal });
  assert.ok(retried.ok, JSON.stringify(retried)); assert.equal(retried.value.placedThisCall, 0);
  assert.equal(state.length, 0);
});

test("changed or unconfirmed temporary blocks are never removed", async () => {
  for (const unconfirmed of [false, true]) {
    const ops = setup(), state: ScaffoldState = [];
    ops.onRemove = async () => failure("BLOCKED", "Keep tracked dirt for next call");
    await new Builder(ops, state).build(compile(), input, { signal: new AbortController().signal });
    assert.ok(state.length > 0);
    if (unconfirmed) state[0]!.stateId = null;
    else ops.set(state[0]!.position, "oak_planks");
    ops.onRemove = undefined;
    const failed = await new Builder(ops, state).build(compile(), input, { signal: new AbortController().signal });
    assert.ok(!failed.ok); assert.equal(failed.error.facts?.reason, "SCAFFOLD_OWNERSHIP_UNCERTAIN");
    assert.equal(ops.removals.length, 0);
  }
});

test("stop during cleanup starts no further dig and retains the remaining positions", async () => {
  const ops = setup(), state: ScaffoldState = [], abort = new AbortController();
  await assert.rejects(new Builder(ops, state).build(compile(), input, {
    signal: abort.signal,
    trace: event => { if (event.event === "scaffold_remove_confirmed") abort.abort(new Error("stop cleanup")); },
  }), /stop cleanup/);
  assert.equal(ops.removals.length, 1); assert.ok(state.length > 0);
  assert.ok((await new Builder(ops, state).build(compile(), input, { signal: new AbortController().signal })).ok);
  assert.equal(state.length, 0);
});
