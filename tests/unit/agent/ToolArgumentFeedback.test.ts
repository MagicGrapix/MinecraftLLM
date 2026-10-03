import assert from "node:assert/strict";
import test from "node:test";
import { GotoCapability } from "../../../src/capabilities/Goto";
import { CraftFromInventoryCapability, CraftFromTableCapability } from "../../../src/capabilities/Craft";
import { CoordinatorTools } from "../../../src/agent/CoordinatorTools";
import { invalidToolArguments, parseToolArguments } from "../../../src/shared/ToolArgumentFeedback";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";
import { toJsonSchema } from "../../../src/agent/ToolCatalogBuilder";
import { BlockPositionSchema } from "../../../src/shared/types";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("position schemas describe objects and distinguish movement decimals from block cells", () => {
  const move = new GotoCapability().inputSchema;
  assert.equal(move.safeParse({ position: { x: 2.5, y: -60, z: 5 } }).success, true);
  assert.equal(BlockPositionSchema.safeParse({ x: 2.5, y: -60, z: 5 }).success, false);
  const schema = JSON.stringify(toJsonSchema(move));
  assert.match(schema, /decimals allowed/);
  assert.match(schema, /Example:/);
  assert.match(JSON.stringify(toJsonSchema(BlockPositionSchema)), /integer x, y, z/);
});

test("invalid position feedback includes received value, actual schema and no-execution guarantee", () => {
  const schema = new GotoCapability().inputSchema;
  const raw = { position: "[2, -60, 5]", goal: "near" };
  const parsed = schema.safeParse(raw);
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const text = invalidToolArguments("goto", raw, parsed.error.issues, schema);
  for (const pattern of [/"goto"/, /Field position/, /Received: "\[2, -60, 5\]"/, /Expected schema:/, /Example:/, /No tool was executed/]) assert.match(text, pattern);
  assert.equal(raw.position, "[2, -60, 5]", "Feedback does not silently coerce the input.");
});

test("coordinator gets the same actionable schema feedback including array-of-names examples", () => {
  const tools = new CoordinatorTools(createDefaultWorldQueryRegistry({} as WorldQueries));
  assert.throws(() => tools.parse({ id: "bad", name: "find_nearest_blocks", arguments: '{"names":"oak_log,log,oak_planks"}' }), (error: any) => {
    assert.match(error.message, /find_nearest_blocks/);
    assert.match(error.message, /Field names/);
    assert.match(error.message, /oak_log,log,oak_planks/);
    assert.match(error.message, /array/);
    assert.match(error.message, /No tool was executed/);
    return true;
  });
  assert.deepEqual(tools.parse({ id: "valid", name: "find_nearest_blocks", arguments: '{"names":["oak_log"]}' }),
    { name: "query", query: "find_nearest_blocks", input: { names: ["oak_log"] } });
});

test("invalid JSON and non-object arguments identify the tool and rejected input", () => {
  for (const raw of ['{"position":', '"[2,-60,5]"', "[]", "null"]) {
    assert.throws(() => parseToolArguments("goto", raw), /Invalid arguments for "goto".*Received:.*No tool was executed/);
  }
});

test("inventory crafting feedback identifies a numeric quantity and gives a station-free example", () => {
  const capability = new CraftFromInventoryCapability();
  const raw = { item: "oak_planks", quantity: "4" };
  const parsed = capability.inputSchema.safeParse(raw);
  if (parsed.success) assert.fail("String quantity must fail.");
  const text = invalidToolArguments(capability.name, raw, parsed.error.issues, capability.inputSchema);
  assert.match(text, /craft_from_inventory_2x2/);
  assert.match(text, /Field quantity: Expected number, received string/);
  assert.match(text, /Input guide: Example: \{"item":"oak_planks","quantity":4\}/);
  assert.match(text, /No tool was executed/);
});

test("table crafting feedback identifies a missing table position and gives a complete example", () => {
  const capability = new CraftFromTableCapability();
  const raw = { item: "wooden_pickaxe", quantity: 1 };
  const parsed = capability.inputSchema.safeParse(raw);
  if (parsed.success) assert.fail("Missing tablePosition must fail.");
  const text = invalidToolArguments(capability.name, raw, parsed.error.issues, capability.inputSchema);
  assert.match(text, /Field tablePosition: Required/);
  assert.match(text, /Input guide: Example:.*"tablePosition":\{"x":2,"y":-60,"z":5\}/);
  assert.match(text, /No tool was executed/);
});
