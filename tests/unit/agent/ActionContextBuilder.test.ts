import assert from "node:assert/strict";
import test from "node:test";
import { ActionContextBuilder } from "../../../src/agent/ActionContextBuilder";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("action context provides the full plan and past reports, keeping raw action results in debug only", () => {
  let count = 1;
  const world = {
    getSelf: () => ({ position: { x: 10.53869625851037, y: -60, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, onGround: true }),
    getInventory: () => ({ items: [{ name: "oak_log", count, slot: 36 }], selectedItem: null }),
  } as unknown as WorldQueries;
  const builder = new ActionContextBuilder({
    world,
    landmarks: { pinned: () => [{ name: "table", kind: "crafting_table", dimension: "overworld", position: { x: 3, y: -60, z: 1 }, status: "stale" }] } as unknown as LandmarkMemory,
    systemPrompt: PromptTemplate.fromString("sys", "TASK={{task_context}}\n{{task_summary_section}}\nWORLD={{world_context}}"),
    conversationSummaryPrompt: PromptTemplate.fromString("summary", "Previous conversation summary: empty."),
  });
  const input = {
    delegation: {
      step: { step: 2, title: "Craft a table", successCriteria: "A table is in the bot inventory." },
      instruction: "Use the planks to make a table.", userObjective: "Make a table",
      checklist: "- [x] 1. Craft planks\n- [ ] 2. Craft a table\n- [ ] 3. Place the table",
      projectSummary: "Crafted planks.",
      reports: [{ step: 1, status: "success" as const, message: "Crafted four oak planks." }],
    },
    lastTask: { id: "internal-id", capability: "craft_from_inventory_2x2", input: { item: "oak_planks", quantity: 4 }, createdAt: 1 },
    lastResult: { ok: true as const, value: { item: "oak_planks", count: 4, distance: 10.53869625851037 } },
  };
  const built = builder.build(input);
  const system = built.messages[0]!.content!;
  assert.match(system, /Objective: Make a table/);
  assert.match(system, /Current step 2: Craft a table/);
  assert.match(system, /Success criterion: A table is in the bot inventory/);
  assert.ok(system.includes(input.delegation.checklist));
  assert.match(system, /Step 1 reported success: Crafted four oak planks/);
  assert.match(system, /past claims; only \[x\] steps are coordinator-verified/);
  assert.match(system, /## Task Summary\n\nCrafted planks/);
  assert.match(system, /Bot position: \(10\.54, -60, 0\)/);
  assert.match(system, /Bot inventory: oak_log x1/);
  assert.match(system, /"table": crafting_table at \(3, -60, 1\) in overworld; stale/);
  assert.doesNotMatch(system, /Last Action Result|distance|internal-id|createdAt|permission|workingMemory|"phase"/);
  assert.deepEqual(built.snapshot.lastTask, input.lastTask);
  assert.deepEqual(built.snapshot.lastResult, input.lastResult);
  assert.equal(built.snapshot.self.position.x, 10.53869625851037);
  assert.equal("localPlan" in built.snapshot, false);
  assert.equal("capabilities" in built.snapshot, false);
  assert.deepEqual(built.messages.slice(1), [{ role: "assistant", content: "Previous conversation summary: empty." }, { role: "user", content: input.delegation.instruction }]);
  count = 2;
  assert.match(builder.build(input).messages[0]!.content!, /Bot inventory: oak_log x2/);
  input.delegation.reports[0]!.message = "Changed caller state";
  assert.equal(built.snapshot.delegation.reports[0]!.message, "Crafted four oak planks.");
});
