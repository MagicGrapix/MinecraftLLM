import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityRegistry } from "../../../src/bootstrap/createCapabilities";
import { ToolCatalogBuilder } from "../../../src/agent/ToolCatalogBuilder";
import { WorldQueryRegistry } from "../../../src/world/queries/WorldQueryRegistry";
import { buildOpenAIRequestBody } from "../../../src/llm/openaiRequestBody";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("bootstrap exposes every capability with an actionable description", () => {
  const registry = createCapabilityRegistry();
  const summaries = registry.list();

  assert.equal(summaries.length, 18);
  assert.equal(registry.get("build")?.defaultTimeoutMs, 300_000);
  assert.equal(registry.get("collect_resource")?.defaultTimeoutMs, 300_000);
  assert.equal(
    summaries.every(
      (summary) =>
        summary.description.length > 20 &&
        registry.has(summary.name) &&
        registry.get(summary.name)?.inputSchema !== undefined,
    ),
    true,
  );
});

test("LLM catalog exposes exactly two flat crafting schemas and no legacy craft tool", () => {
  const registry = createCapabilityRegistry();
  const tools = new ToolCatalogBuilder(registry, new WorldQueryRegistry({} as WorldQueries)).build();
  const body = buildOpenAIRequestBody({ messages: [], tools }, "test-model");
  const sentTools = body.tools as Array<{ function: { name: string; parameters: Record<string, any> } }>;
  assert.equal(registry.has("craft"), false);
  assert.equal(sentTools.some(tool => tool.function.name === "craft"), false);
  const expected = [
    ["craft_from_inventory_2x2", ["item", "quantity"]],
    ["craft_from_table_3x3", ["item", "quantity", "tablePosition"]],
  ] as const;
  for (const [name, fields] of expected) {
    const schema = sentTools.find(tool => tool.function.name === name)!.function.parameters;
    assert.equal(schema.type, "object");
    assert.deepEqual(Object.keys(schema.properties), fields);
    assert.deepEqual(schema.required, fields);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.anyOf, undefined);
    assert.equal(schema.oneOf, undefined);
    assert.equal(schema.properties.quantity.type, "integer");
    assert.match(schema.description, /Example:/);
  }
});

test("station catalog exposes four small schemas without coordinates or public sessions", () => {
  const registry = createCapabilityRegistry();
  for (const name of ["open_container", "transfer_item", "close_container", "open_furnace"]) assert.equal(registry.has(name), false);
  const tools = new ToolCatalogBuilder(registry, new WorldQueryRegistry({} as WorldQueries)).build();
  const body = buildOpenAIRequestBody({ messages: [], tools }, "test-model");
  const sent = body.tools as Array<{ function: { name: string; parameters: Record<string, any> } }>;
  for (const [name, keys] of [
    ["get_chest_contents", []], ["use_chest", ["direction", "item", "quantity"]],
    ["get_furnace_contents", []], ["use_furnace", ["inputItem", "quantity", "fuel"]],
  ] as const) {
    const schema = sent.find(t => t.function.name === name)!.function.parameters;
    assert.deepEqual(Object.keys(schema.properties), keys);
    assert.equal(schema.additionalProperties, false);
    assert.equal(registry.has(name), true);
  }
  assert.equal(registry.get("use_furnace")!.defaultTimeoutMs, 210_000);
});
