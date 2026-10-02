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
import type { BlockAccessInfo } from "../../../src/world/BlockAccess";
import { MessageHistory } from "../../../src/agent/MessageHistory";

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
  getBlockAccess: () => { throw new Error("Block access was not stubbed."); },
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
            description: "Perform one test action.",
            tasks: [{ capability: "test_action", input: { value: 3 } }],
          }),
        },
      ],
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
                description: "Perform an unknown action.",
                tasks: [{ capability: "missing", input: {} }],
              }),
            },
          ],
        ),
      /unknown/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single actioner catalog includes queries and decisions, never direct capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-catalog-"));
  try {
    const bridge = await createBridge(root);
    const actionTools = bridge.catalog.build().map((tool) => tool.name);
    assert.equal(actionTools.includes("get_voxel_view"), true);
    assert.equal(actionTools.includes("get_block_access"), true);
    assert.equal(actionTools.includes("test_action"), false);
    assert.equal(actionTools.includes("set_plan"), true);
    assert.equal(actionTools.includes("continue_plan"), true);
    assert.equal(actionTools.includes("finish_step"), true);
    assert.equal(actionTools.includes("finish_run"), false);
    const finished = bridge.validateResponseCalls([{ id: "finish", name: "finish_step", arguments: '{"status":"success","message":"Step verified."}' }]);
    assert.deepEqual(finished, { kind: "decision", decision: { type: "finish_step", status: "success", message: "Step verified." } });
    assert.throws(() => bridge.parseDecision({ id: "old", name: "finish_run", arguments: '{"status":"success","message":"Old name."}' }), ModelResponseError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("block access is a read tool and raw precision is only rounded in model history", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-block-access-bridge-"));
  try {
    const position = { x: 7, y: -59, z: 4 };
    const expected: BlockAccessInfo = {
      position, loaded: true, block: "oak_log", distanceFromEyes: 3.30352210163947,
      reach: 5, withinReach: true, visible: false, canDig: false,
      reason: "occluded", blocker: { block: "oak_leaves", position: { x: 8, y: -59, z: 4 } },
    };
    const bridge = await createBridge(root, { ...world, getBlockAccess: () => expected });
    const call = { id: "access", name: "get_block_access", arguments: JSON.stringify({ position }) };
    assert.equal(bridge.isReadTool(call.name), true);
    assert.equal(bridge.isDecision(call.name), false);
    assert.equal(bridge.validateResponseCalls([call]).kind, "reads");
    assert.throws(() => bridge.validateResponseCalls([{ ...call, arguments: JSON.stringify({ position: JSON.stringify(position) }) }]), ModelResponseError);
    const result = await bridge.executeRead(call);
    assert.equal(result.ok, true, "An observed obstruction is a successful read, not a query execution error.");
    assert.equal(result.toolCallId, "access");
    assert.deepEqual(JSON.parse(result.content), { ok: true, value: expected });
    for (const mode of ["native", "compact"] as const) {
      const history = new MessageHistory(20, 30_000, mode);
      history.appendExchange({ role: "assistant", content: null, toolCalls: [call] },
        [{ role: "tool", toolCallId: result.toolCallId, content: result.content }]);
      const presented = JSON.parse(history.snapshot().messages.at(-1)!.content!);
      assert.equal(presented.value.distanceFromEyes, 3.3);
      assert.equal(presented.value.canDig, false);
      assert.deepEqual(presented.value.blocker, expected.blocker);
    }
    assert.equal(expected.distanceFromEyes, 3.30352210163947);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createBridge(root: string, queryWorld: WorldQueries = world): Promise<AgentToolBridge> {
  const capabilities = new CapabilityRegistry();
  const capability: Capability<{ value: number }, null> = {
    name: "test_action",
    description: "Perform one test action.",
    inputSchema: z.object({ value: z.number().int() }).strict(),
    execute: async () => success(null),
  };
  capabilities.register(capability);
  const queries = createDefaultWorldQueryRegistry(queryWorld);
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
