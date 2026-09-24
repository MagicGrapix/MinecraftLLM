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
    landmarks: { pinned: () => [{ name: "table" }] } as unknown as LandmarkMemory,
    capabilities: {
      list: () => [{ name: "dig", description: "Dig a block." }],
    } as unknown as CapabilityRegistry,
    systemPrompt: PromptTemplate.fromString("sys", "CTX={{current_context}}"),
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
    lastResult: { ok: true, value: { item: "oak_planks", count: 4 } },
    remainingPlan: [{ capability: "place", input: { item: "crafting_table" } }],
    instruction: "Review the latest TaskResult.",
  });

  const system = built.messages[0];
  assert.ok(system && system.role === "system");
  const context = JSON.parse(system.content.replace(/^CTX=/, "")) as {
    objective: string;
    workingMemory: string;
    remainingPlan: unknown[];
    lastResult: { ok: boolean };
    capabilities: { name: string }[];
  };
  assert.equal(context.objective, "craft a table");
  assert.equal(context.workingMemory, "Crafted planks.");
  assert.equal(context.remainingPlan.length, 1);
  assert.equal(context.lastResult.ok, true);
  assert.equal(context.capabilities[0]?.name, "dig");
  assert.equal(built.messages[1]?.role, "user");
});

const world: WorldQueries = {
  getSelf: () => ({
    position: { x: 0, y: -60, z: 0 },
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
