import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import type {
  ExecutionController,
  ExecutionSnapshot,
} from "../../../src/execution/ExecutionController";
import { ConversationHistory } from "../../../src/memory/ConversationHistory";
import { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { RecentActivityBuffer } from "../../../src/memory/RecentActivityBuffer";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { SkillRegistry } from "../../../src/skills/SkillRegistry";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";
import { AgentContextBuilder } from "../../../src/agent/AgentContextBuilder";

test("context always preserves stop state, snapshot, pinned landmarks, and current input", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-context-"));
  try {
    const world = emptyWorld();
    const landmarks = await LandmarkMemory.load(
      join(root, "landmarks.json"),
      { createId: () => "base-id" },
    );
    await landmarks.remember({
      name: "Base",
      kind: "base",
      dimension: "overworld",
      position: { x: 10, y: 64, z: 20 },
      source: "user",
      pinned: true,
    });
    const activities = new RecentActivityBuffer();
    for (let index = 0; index < 15; index += 1) {
      activities.add({
        kind: "old",
        summary: `old-${index}-${"x".repeat(100)}`,
      });
    }
    const history = new ConversationHistory();
    history.appendTurn([
      { role: "user", content: "old user" },
      { role: "assistant", content: "old response" },
    ]);
    const snapshot: ExecutionSnapshot = {
      revision: 7,
      mode: "paused",
      current: null,
      pending: [],
      shutdown: false,
    };
    const skills = await SkillRegistry.discover(
      resolve(process.cwd(), "skills"),
    );
    const builder = new AgentContextBuilder({
      world,
      controller: {
        snapshot: () => snapshot,
      } as ExecutionController,
      capabilities: new CapabilityRegistry(),
      queries: createDefaultWorldQueryRegistry(world),
      skills,
      landmarks,
      activities,
      history,
      systemPrompt: PromptTemplate.fromString(
        "test-system",
        "CONTEXT={{current_context}}\nACTIVITY={{recent_activity}}",
      ),
      budgetChars: 2_500,
    });

    const messages = builder.build({
      manualStopped: true,
      permission: "resume_review",
      generationId: 3,
      wakeReason: "resume_requested",
      activeDirective: "construire une base",
      currentInput: "revalide maintenant",
    });
    const system = messages[0];
    assert.equal(system?.role, "system");
    assert.match(system?.content ?? "", /"manualStopped":true/);
    assert.match(system?.content ?? "", /"revision":7/);
    assert.match(system?.content ?? "", /"name":"Base"/);
    assert.deepEqual(messages.at(-1), {
      role: "user",
      content: "revalide maintenant",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function emptyWorld(): WorldQueries {
  return {
    getSelf: () => ({
      position: { x: 0, y: 64, z: 0 },
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
}
