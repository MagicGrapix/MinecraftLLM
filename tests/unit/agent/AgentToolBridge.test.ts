import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { AgentToolBridge } from "../../../src/agent/AgentToolBridge";
import { ModelResponseError } from "../../../src/agent/ModelResponseError";
import type { Capability } from "../../../src/capabilities/Capability";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { success } from "../../../src/execution/TaskResult";
import { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { SkillLoader } from "../../../src/skills/SkillLoader";
import { SkillRegistry } from "../../../src/skills/SkillRegistry";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";

const world: WorldQueries = {
  getSelf: () => ({
    position: { x: 0, y: 64, z: 0 },
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

test("bridge allows queries and validated decisions without queue revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-bridge-"));
  try {
    const bridge = await createBridge(root);
    const self = await bridge.executeRead({
      id: "self",
      name: "get_self",
      arguments: "{}",
    });
    assert.equal(self.ok, true);

    const voxelView = await bridge.executeRead({
      id: "voxel-view",
      name: "get_voxel_view",
      arguments: JSON.stringify({ center: { kind: "self" } }),
    });
    assert.equal(voxelView.ok, true);
    assert.match(voxelView.content, /"layers"/);

    const decision = bridge.validateResponseCalls(
      [
        {
          id: "plan",
          name: "set_plan",
          arguments: JSON.stringify({
            tasks: [{ capability: "test_action", input: { value: 3 } }],
          }),
        },
      ],
      "action",
    );
    assert.equal(decision.kind, "decision");
    if (decision.kind === "decision") {
      assert.equal(decision.decision.type, "set_plan");
    }

    assert.throws(
      () =>
        bridge.validateResponseCalls(
          [
            {
              id: "plan",
              name: "set_plan",
              arguments: JSON.stringify({
                tasks: [{ capability: "test_action", input: { value: 3 } }],
              }),
            },
          ],
          "readonly",
        ),
      ModelResponseError,
    );
    assert.throws(
      () =>
        bridge.validateResponseCalls(
          [
            {
              id: "plan",
              name: "set_plan",
              arguments: JSON.stringify({
                tasks: [{ capability: "missing", input: {} }],
              }),
            },
          ],
          "action",
        ),
      /unknown/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readonly catalog hides terminal decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-catalog-"));
  try {
    const bridge = await createBridge(root);
    const readonlyTools = bridge.catalog.build("readonly").map((tool) => tool.name);
    const actionTools = bridge.catalog.build("action").map((tool) => tool.name);
    assert.equal(readonlyTools.includes("get_voxel_view"), true);
    assert.equal(readonlyTools.includes("set_plan"), false);
    assert.equal(actionTools.includes("set_plan"), true);
    assert.equal(actionTools.includes("continue_plan"), true);
    assert.equal(actionTools.includes("finish_step"), true);
    assert.equal(actionTools.includes("finish_run"), false);
    assert.equal(readonlyTools.includes("finish_step"), false);
    const finished = bridge.validateResponseCalls([{ id: "finish", name: "finish_step", arguments: '{"status":"success","message":"Step verified."}' }], "action");
    assert.deepEqual(finished, { kind: "decision", decision: { type: "finish_step", status: "success", message: "Step verified." } });
    assert.throws(() => bridge.parseDecision({ id: "old", name: "finish_run", arguments: '{"status":"success","message":"Old name."}' }), ModelResponseError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createBridge(root: string): Promise<AgentToolBridge> {
  const capabilities = new CapabilityRegistry();
  const capability: Capability<{ value: number }, null> = {
    name: "test_action",
    description: "Perform one test action.",
    inputSchema: z.object({ value: z.number().int() }).strict(),
    execute: async () => success(null),
  };
  capabilities.register(capability);
  const queries = createDefaultWorldQueryRegistry(world);
  const skills = await SkillRegistry.discover(resolve(process.cwd(), "skills"));
  const landmarks = await LandmarkMemory.load(join(root, "landmarks.json"));
  return new AgentToolBridge({
    capabilities,
    queries,
    skills,
    skillLoader: new SkillLoader(skills, capabilities, queries),
    landmarks,
  });
}
