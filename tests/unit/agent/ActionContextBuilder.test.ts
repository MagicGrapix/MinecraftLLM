import assert from "node:assert/strict";
import test from "node:test";
import { ActionContextBuilder } from "../../../src/agent/ActionContextBuilder";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("action context separates delegation and last action from fresh world without a local queue or capability summary", () => {
  let count = 1;
  const world = {
    getSelf: () => ({ position: { x: 10.53869625851037, y: -60, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, onGround: true }),
    getInventory: () => ({ items: [{ name: "oak_log", count, slot: 36 }], selectedItem: null }),
  } as unknown as WorldQueries;
  const builder = new ActionContextBuilder({
    world,
    landmarks: { pinned: () => [{ name: "table", kind: "crafting_table", dimension: "overworld", position: { x: 3, y: -60, z: 1 }, status: "stale" }] } as unknown as LandmarkMemory,
    systemPrompt: PromptTemplate.fromString("sys", "TASK={{task_context}}\nLAST={{last_action}}\nWORLD={{world_context}}"),
    conversationSummaryPrompt: PromptTemplate.fromString("summary", "Previous conversation summary: empty."),
  });
  const input = {
    delegation: { step: { step: 2, title: "Craft a table", successCriteria: "A table is in the bot inventory." }, instruction: "Use the planks to make a table.", userObjective: "Make a table", checklist: "- [ ] 2. Craft a table", projectSummary: "Crafted planks." },
    lastTask: { id: "internal-id", capability: "craft", input: { item: "oak_planks" }, createdAt: 1 },
    lastResult: { ok: true as const, value: { item: "oak_planks", count: 4, distance: 10.53869625851037 } },
  };
  const built = builder.build(input);
  const system = built.messages[0]!.content!;
  assert.match(system, /Delegated step 2: Craft a table/);
  assert.match(system, /Success criterion: A table is in the bot inventory/);
  assert.match(system, /Crafted planks/);
  assert.match(system, /"distance":10\.54/);
  assert.match(system, /Bot position: \(10\.54, -60, 0\)/);
  assert.match(system, /Bot inventory: oak_log x1/);
  assert.match(system, /"table": crafting_table at \(3, -60, 1\) in overworld; stale/);
  assert.doesNotMatch(system, /internal-id|createdAt|permission|workingMemory|"phase"/);
  assert.deepEqual(built.snapshot.lastResult, input.lastResult);
  assert.equal(built.snapshot.self.position.x, 10.53869625851037);
  assert.equal("localPlan" in built.snapshot, false);
  assert.equal("capabilities" in built.snapshot, false);
  assert.deepEqual(built.messages.slice(1), [{ role: "assistant", content: "Previous conversation summary: empty." }, { role: "user", content: input.delegation.instruction }]);
  count = 2;
  assert.match(builder.build(input).messages[0]!.content!, /Bot inventory: oak_log x2/);
});
