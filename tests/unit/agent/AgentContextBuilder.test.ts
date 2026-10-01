import assert from "node:assert/strict";
import test from "node:test";
import { AgentContextBuilder } from "../../../src/agent/AgentContextBuilder";
import type { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("context includes objective, memory, inventory, last result, and remaining plan", () => {
  const builder = new AgentContextBuilder({
    world,
    landmarks: { pinned: () => [{ name: "table", kind: "crafting_table", dimension: "overworld", position: { x: 3, y: -60, z: 1 }, status: "stale" }] } as unknown as LandmarkMemory,
    capabilities: {
      list: () => [{ name: "dig", description: "Dig a block." }],
    } as unknown as CapabilityRegistry,
    systemPrompt: PromptTemplate.fromString("sys", "CTX={{current_context}}\nWORLD={{world_context}}"),
    conversationSummaryPrompt: PromptTemplate.fromString("conversation-summary", "Previous conversation summary: empty."),
  });

  const built = builder.build({
    runId: 4,
    phase: "review",
    permission: "action",
    objective: "craft a table",
    workingMemory: "Crafted planks.",
    currentTask: null,
    lastTask: {
      id: "task-1",
      capability: "craft",
      input: { item: "oak_planks" },
      createdAt: 1,
    },
    lastResult: { ok: true, value: { item: "oak_planks", count: 4, distance: 10.53869625851037 } },
    remainingPlan: [{ capability: "place", input: { item: "crafting_table" } }],
    instruction: "Review the latest TaskResult.",
  });

  const system = built.messages[0];
  assert.ok(system && system.role === "system");
  const context = JSON.parse(system.content.replace(/^CTX=/, "").split("\nWORLD=")[0]!) as {
    objective: string;
    workingMemory: string;
    remainingPlan: unknown[];
    lastResult: { ok: boolean; value: { distance: number } };
    capabilities: { name: string }[];
  };
  assert.equal(context.objective, "craft a table");
  assert.equal(context.workingMemory, "Crafted planks.");
  assert.equal(context.remainingPlan.length, 1);
  assert.equal(context.lastResult.ok, true);
  assert.equal(context.lastResult.value.distance, 10.54);
  assert.deepEqual(built.snapshot.lastResult, { ok: true, value: { item: "oak_planks", count: 4, distance: 10.53869625851037 } });
  assert.equal(context.capabilities[0]?.name, "dig");
  assert.equal(built.messages[1]?.role, "assistant");
  assert.equal(built.messages[2]?.role, "user");
  assert.match(system.content, /Bot inventory: empty/);
  assert.match(system.content, /"table": crafting_table at \(3, -60, 1\) in overworld; stale/);
  assert.equal("inventory" in context, false);
  assert.deepEqual(built.snapshot.inventory, { items: [], selectedItem: null });
});

const world: WorldQueries = {
  getSelf: () => ({
    position: { x: 0, y: -60, z: 0 },
    facing: "north",
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    onGround: true,
  }),
  getInventory: () => ({ items: [], selectedItem: null }),
  getBlock: () => null,
  findNearestBlocks: () => [],
  getNearbyEntities: () => [],
};
