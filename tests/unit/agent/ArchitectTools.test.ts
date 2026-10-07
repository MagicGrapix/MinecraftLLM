import assert from "node:assert/strict";
import test from "node:test";
import { ArchitectTools } from "../../../src/agent/ArchitectTools";
import { failure } from "../../../src/execution/TaskResult";

const noStorage = new ArchitectTools({ save: async () => { throw new Error("Invalid drawings must not call storage"); } });
const call = (args: unknown) => ({ id: "draw", name: "submit_blueprint", arguments: JSON.stringify(args) });
const signal = new AbortController().signal;

test("Architect only exposes one drawing string, no dimensions, palette or lookup", () => {
  assert.deepEqual(noStorage.definitions.map(t => t.name), ["submit_blueprint"]);
  const schema = noStorage.definitions[0]!.parameters;
  assert.deepEqual(schema.required, ["drawing"]);
  assert.deepEqual(Object.keys(schema.properties as object), ["drawing"]);
  assert.equal(schema.additionalProperties, false);
});

test("invalid argument shapes and drawing errors are retryable feedback without saving", async () => {
  for (const args of [{}, { drawing: [] }, { drawing: "A", palette: {} }, { drawing: "A", width: 1 }, { drawing: "B" }, { drawing: "_" }, { drawing: "AAA\nAA" }, null]) {
    const outcome = await noStorage.execute(call(args), signal);
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.fatal, undefined);
  }
});

test("valid drawing is adapted to the internal blueprint before storage", async () => {
  let received: unknown;
  const saveFailure = failure("INTERNAL_ERROR", "Storage unavailable", { facts: { reason: "BLUEPRINT_IO_ERROR" } });
  const tools = new ArchitectTools({ save: async args => { received = args; return saveFailure; } });
  const result = await tools.execute(call({ drawing: "AAA\nAAA\nAAA" }), signal);
  assert.deepEqual(received, { name: "oak_structure_3x3x1", description: "Oak structure designed by the Architect.",
    width: 3, depth: 3, palette: { A: "oak_planks" }, layers: [["AAA", "AAA", "AAA"]], dependencies: { doors: [] } });
  assert.deepEqual(result, { result: saveFailure, fatal: true });
});

test("unavailable tools and malformed JSON are rejected without invoking them", async () => {
  for (const name of ["goto", "lookup_material"]) {
    const result = await noStorage.execute({ id: "no", name, arguments: "bad json" }, signal);
    assert.ok(!result.result.ok && result.result.error.facts?.reason === "UNKNOWN_TOOL");
  }
  const bad = await noStorage.execute({ id: "no", name: "submit_blueprint", arguments: "{bad" }, signal);
  assert.ok(!bad.result.ok && bad.result.error.facts?.reason === "INVALID_TOOL_ARGUMENTS");
});
