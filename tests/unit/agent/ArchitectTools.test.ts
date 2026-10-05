import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { ArchitectTools } from "../../../src/agent/ArchitectTools";
import { failure } from "../../../src/execution/TaskResult";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";

const tools = new ArchitectTools(new MaterialCatalog(minecraftData("1.21.11")), {
  save: async () => { throw new Error("Lookup must not call storage"); },
});

test("material lookup distinguishes registry existence from blueprint support", async () => {
  for (const [name, kind, support] of [
    ["minecraft:oak_planks", "block", "palette_cube"],
    ["oak_door", "item", "door_dependency"],
    ["oak_stairs", "block", "unsupported"],
    ["diamond_sword", "item", "unsupported"],
  ]) {
    const outcome = await tools.execute({ id: "lookup", name: "lookup_material", arguments: JSON.stringify({ query: name, kind }) }, new AbortController().signal);
    assert.deepEqual(outcome, { result: { ok: true, value: {
      minecraftVersion: "1.21.11", exact: { name: name!.replace("minecraft:", ""), kind, blueprintSupport: support }, suggestions: [],
    } } });
  }
  assert.ok(tools.supportedMaterials().cubes.includes("oak_planks"));
  assert.deepEqual(tools.supportedMaterials().doors, ["oak_door"]);
});

test("lookup validates defaults and rejects extra fields, blank/long query or invalid kind", async () => {
  const signal = new AbortController().signal;
  const lookup = (args: unknown) => tools.execute({ id: "lookup", name: "lookup_material", arguments: JSON.stringify(args) }, signal);
  assert.deepEqual(await lookup({ query: "oak_planks" }), { result: { ok: true, value: {
    minecraftVersion: "1.21.11", exact: { name: "oak_planks", kind: "block", blueprintSupport: "palette_cube" }, suggestions: [],
  } } });
  for (const args of [{ query: "" }, { query: "a".repeat(129) }, { query: "oak", kind: "entity" }, { query: "oak", surprise: true }, null]) {
    const outcome = await lookup(args);
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.fatal, undefined);
  }
});

test("unavailable tools are rejected without parsing or invoking them", async () => {
  assert.deepEqual(await tools.execute({ id: "no", name: "goto", arguments: "bad json" }, new AbortController().signal), {
    result: failure("INVALID_ARGUMENT", "Unknown Architect tool. Use lookup_material or submit_blueprint.", { facts: { reason: "UNKNOWN_TOOL", tool: "goto" } }),
  });
});
