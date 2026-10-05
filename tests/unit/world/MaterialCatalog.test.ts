import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";

const registry = minecraftData("1.21.11");
const catalog = new MaterialCatalog(registry);

test("material catalog uses exact, versioned block/item IDs and optional minecraft namespace", () => {
  assert.equal(catalog.minecraftVersion, "1.21.11");
  assert.deepEqual(catalog.resolve("block", "minecraft:oak_planks"), { name: "oak_planks", kind: "block" });
  assert.deepEqual(catalog.resolve("item", "stick"), { name: "stick", kind: "item" });
  for (const name of ["oak_plate", "Oak_Planks", "mod:oak_planks", " oak_planks", "log", "__proto__", "constructor"]) {
    assert.equal(catalog.resolve("block", name), null, name);
  }
  assert.equal(catalog.resolve("block", "stick"), null);
  assert.equal(catalog.resolve("item", "water"), null);
});

test("catalog resolves an exact search without replacing it with similar names", () => {
  const result = catalog.search(" minecraft:oak_planks ");
  assert.equal(result.exact?.name, "oak_planks");
  assert.deepEqual(result.suggestions, []);
});

test("material suggestions include spelling and word matches, are stable and bounded", () => {
  const result = catalog.search("oak_plate");
  assert.equal(result.exact, null);
  assert.ok(result.suggestions.some((candidate) => candidate.name === "oak_planks"));
  assert.ok(result.suggestions.some((candidate) => candidate.name === "oak_pressure_plate"));
  assert.ok(result.suggestions.length <= 5);
  assert.deepEqual(catalog.search("oak_plate"), result);
  assert.ok(catalog.search("planks").suggestions.every((candidate) => candidate.name.includes("planks")));
});

test("suggestion normalization never turns a mistyped ID into an exact match", () => {
  for (const query of ["Oak_Planks", "oak planks"]) {
    const result = catalog.search(query);
    assert.equal(result.exact, null);
    assert.equal(result.suggestions[0]?.name, "oak_planks");
  }
});

test("unknown unrelated words return no suggestions and query size is bounded", () => {
  assert.deepEqual(catalog.search("zzzzzzzzzzzzzzzzzzzz").suggestions, []);
  assert.throws(() => catalog.search(" "), RangeError);
  assert.throws(() => catalog.search("x".repeat(129)), RangeError);
});

test("catalog does not confuse a full collision box with supported blueprint placement", () => {
  assert.equal(catalog.isFullBlock("minecraft:oak_planks"), true);
  assert.equal(catalog.isFullBlock("sand"), true);
  assert.equal(catalog.isFullBlock("water"), false);
  assert.equal(catalog.isFullBlock("unknown"), false);
  assert.equal(catalog.search("oak_door").exact?.name, "oak_door");
});

test("catalog snapshots a registry rather than observing later mutations", () => {
  const blocksByName = { ...registry.blocksByName };
  const snapshot = new MaterialCatalog({ ...registry, blocksByName });
  delete blocksByName.oak_planks;
  assert.ok(snapshot.resolve("block", "oak_planks"));
});
