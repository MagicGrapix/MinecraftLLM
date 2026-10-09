import assert from "node:assert/strict";
import test from "node:test";
import { LayeredArchitectTools } from "../../../src/agent/LayeredArchitectTools";
import { failure } from "../../../src/execution/TaskResult";

const signal = new AbortController().signal;
const call = (name: string, args: unknown) => ({ id: "call", name, arguments: JSON.stringify(args) });
const plan = { width: 2, depth: 2, height: 1, description: "One floor." };

test("layered tools have simple strict schemas and no world or legacy submit tool", () => {
  const tools = new LayeredArchitectTools({ save: async () => { throw new Error("No saving"); } });
  assert.deepEqual(tools.definitions.map(t => t.name), ["start_blueprint", "set_blueprint_layer", "finish_blueprint"]);
  for (const tool of tools.definitions) assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tools.definitions[0]!.parameters.required, ["width", "depth", "height", "description"]);
  assert.deepEqual(tools.definitions[1]!.parameters.required, ["layer", "drawing"]);
  assert.deepEqual(tools.definitions[2]!.parameters.properties, {});
});

test("bounds, unknown tools, malformed JSON and wrong input shapes return feedback with the intact draft", async () => {
  const tools = new LayeredArchitectTools({ save: async () => { throw new Error("No saving"); } });
  for (const args of [{ ...plan, width: 9 }, { ...plan, depth: 9 }, { ...plan, height: 6 }, { ...plan, width: 1.5 }, { ...plan, width: 0 }, { ...plan, description: "" }, { ...plan, layers: [] }]) {
    const outcome = await tools.execute(call("start_blueprint", args), signal);
    assert.ok(!outcome.result.ok);
    assert.match(String(outcome.result.error.facts?.draft), /No draft yet/);
  }
  await tools.execute(call("start_blueprint", plan), signal);
  for (const input of [call("set_blueprint_layer", { layer: 0, drawing: "AA\nAA" }), call("finish_blueprint", { drawing: "AA\nAA" }),
    call("submit_blueprint", { drawing: "AA\nAA" }), call("__proto__", {}), { id: "bad", name: "set_blueprint_layer", arguments: "{bad" }]) {
    const outcome = await tools.execute(input, signal);
    assert.ok(!outcome.result.ok);
    assert.match(String(outcome.result.error.facts?.draft), /Layer 1 — not defined:\nXX\nXX/);
  }
});

test("only explicit finish saves; filesystem failure is fatal while validation feedback is recoverable", async () => {
  let saves = 0;
  const tools = new LayeredArchitectTools({ save: async raw => {
    saves++;
    assert.deepEqual((raw as { layers: string[][] }).layers, [["AA", "AA"]]);
    return failure("INTERNAL_ERROR", "Disk unavailable", { facts: { reason: "BLUEPRINT_IO_ERROR" } });
  } });
  assert.equal((await tools.execute(call("finish_blueprint", {}), signal)).fatal, undefined);
  await tools.execute(call("start_blueprint", plan), signal);
  await tools.execute(call("set_blueprint_layer", { layer: 1, drawing: "AA\nAA" }), signal);
  assert.equal(saves, 0);
  const result = await tools.execute(call("finish_blueprint", {}), signal);
  assert.equal(saves, 1);
  assert.equal(result.fatal, true);
  assert.ok(!result.result.ok);
  assert.match(String(result.result.error.facts?.draft), /1\/1 layers defined/);
  assert.match(result.feedback!, /Error: INTERNAL_ERROR. Disk unavailable/);
  assert.match(result.feedback!, /Layer 1:\nAA\nAA/);
});

test("pre-aborted tool calls cannot mutate the draft or save", async () => {
  const tools = new LayeredArchitectTools({ save: async () => { throw new Error("No saving"); } });
  await assert.rejects(tools.execute(call("start_blueprint", plan), AbortSignal.abort()));
  const result = await tools.execute(call("finish_blueprint", {}), signal);
  assert.ok(!result.result.ok);
  assert.match(String(result.result.error.facts?.draft), /No draft yet/);
});
