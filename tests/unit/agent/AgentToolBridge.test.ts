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
import { ToolCatalogBuilder } from "../../../src/agent/ToolCatalogBuilder";

const world: WorldQueries = {
  isKnownName: () => true,
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

test("bridge allows queries and validates native capability arguments without executing them", async () => {
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

    const dropsCall = { id: "drops", name: "get_dropped_items", arguments: "{}" };
    assert.deepEqual(bridge.validateResponseCalls([dropsCall]), { kind: "read" });
    const drops = await bridge.executeRead(dropsCall);
    assert.equal(drops.ok, true);
    assert.deepEqual(JSON.parse(drops.content), { ok: true, value: [] });

    const decision = bridge.validateResponseCalls(
      [
        {
          id: "plan",
          name: "test_action",
          arguments: JSON.stringify({ value: 3 }),
        },
      ],
    );
    assert.deepEqual(decision, { kind: "action", task: { capability: "test_action", input: { value: 3 } } });

    assert.throws(
      () =>
        bridge.validateResponseCalls(
          [
            {
              id: "plan",
              name: "missing",
              arguments: "{}",
            },
          ],
        ),
      /unknown/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable actioner catalog includes exact native schemas and handoff, not queue tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-catalog-"));
  try {
    const bridge = await createBridge(root);
    const actionTools = bridge.catalog.build().map((tool) => tool.name);
    assert.equal(actionTools.includes("get_voxel_view"), true);
    assert.equal(actionTools.includes("get_block_access"), true);
    assert.equal(actionTools.includes("get_dropped_items"), true);
    assert.equal(actionTools.includes("get_nearby_entities"), false);
    assert.equal(actionTools.includes("test_action"), true);
    assert.equal(actionTools.includes("set_plan"), false);
    assert.equal(actionTools.includes("continue_plan"), false);
    assert.equal(actionTools.includes("get_capability_schemas"), false);
    assert.equal(actionTools.includes("finish_step"), true);
    assert.equal(actionTools.includes("finish_run"), false);
    const finished = bridge.validateResponseCalls([{ id: "finish", name: "finish_step", arguments: '{"status":"success","message":"Step verified."}' }]);
    assert.deepEqual(finished, { kind: "finish", status: "success", message: "Step verified." });
    for (const name of ["set_plan", "continue_plan", "get_capability_schemas", "finish_run", "get_nearby_entities"]) {
      assert.throws(() => bridge.validateResponseCalls([{ id: "old", name, arguments: "{}" }]), /Unknown tool/);
    }
    const native = bridge.catalog.build().find((tool) => tool.name === "test_action")!.parameters;
    assert.deepEqual(native, {
      type: "object", properties: { value: { type: "integer" }, precision: { type: "number", minimum: 0.0001 } },
      required: ["value"], additionalProperties: false,
    });
    assert.equal(bridge.catalog.build(), bridge.catalog.build());
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
    assert.equal(bridge.validateResponseCalls([call]).kind, "read");
    assert.throws(() => bridge.validateResponseCalls([{ ...call, arguments: JSON.stringify({ position: JSON.stringify(position) }) }]), ModelResponseError);
    const result = await bridge.executeRead(call);
    assert.equal(result.ok, true, "An observed obstruction is a successful read, not a query execution error.");
    assert.equal(result.toolCallId, "access");
    assert.deepEqual(JSON.parse(result.content), { ok: true, value: expected });
    for (const mode of ["native", "compact"] as const) {
      const history = new MessageHistory(mode);
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

test("bridge rejects malformed, wrapped, mixed and multi-tool calls before observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-validation-"));
  let reads = 0;
  try {
    const bridge = await createBridge(root, { ...world, getSelf: () => { reads += 1; return world.getSelf(); } });
    const native = { id: "native", name: "test_action", arguments: '{"value":3}' };
    const query = { id: "query", name: "get_self", arguments: "{}" };
    for (const calls of [[], [query, native], [native, native]]) {
      assert.throws(() => bridge.validateResponseCalls(calls), /exactly one/i);
    }
    for (const argumentsText of ["null", "[]", '"string"', '{"value":']) {
      assert.throws(() => bridge.validateResponseCalls([{ ...native, arguments: argumentsText }]), ModelResponseError);
    }
    assert.throws(() => bridge.validateResponseCalls([{ ...native, arguments: '{"value":"3"}' }]), /value: Expected number, received string/);
    assert.throws(() => bridge.validateResponseCalls([{ ...native, arguments: '{"capability":"test_action","input":{"value":3}}' }]), /Invalid arguments/);
    assert.throws(() => bridge.validateResponseCalls([{ ...query, arguments: '{"unwanted":true}' }]), /Invalid arguments/);
    assert.throws(() => bridge.validateResponseCalls([{ id: "finish", name: "finish_step", arguments: '{"status":"success","message":""}' }]), /Invalid arguments/);
    assert.equal(reads, 0);
    assert.deepEqual(bridge.validateResponseCalls([{ ...native, arguments: '{"value":3,"precision":0.00015}' }]), {
      kind: "action", task: { capability: "test_action", input: { value: 3, precision: 0.00015 } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog rejects ambiguous names shared by native capabilities and other tools", () => {
  for (const name of ["get_self", "finish_step", "load_skill"]) {
    const capabilities = new CapabilityRegistry();
    capabilities.register({ name, description: "Collision", inputSchema: z.object({}), execute: async () => success(null) });
    assert.throws(() => new ToolCatalogBuilder(capabilities, createDefaultWorldQueryRegistry(world)), /must be unique/);
  }
});

test("oversized observation is a failed result in both the tool payload and inspector flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-result-limit-"));
  try {
    const bridge = await createBridge(root, world, 5);
    const result = await bridge.executeRead({ id: "self", name: "get_self", arguments: "{}" });
    assert.equal(result.ok, false);
    assert.equal(JSON.parse(result.content).error.code, "RESULT_TOO_LARGE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createBridge(root: string, queryWorld: WorldQueries = world, maxResultChars?: number): Promise<AgentToolBridge> {
  const capabilities = new CapabilityRegistry();
  const capability: Capability<{ value: number }, null> = {
    name: "test_action",
    description: "Perform one test action.",
    inputSchema: z.object({ value: z.number().int(), precision: z.number().min(0.0001).optional() }).strict(),
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
    maxResultChars,
  });
}
