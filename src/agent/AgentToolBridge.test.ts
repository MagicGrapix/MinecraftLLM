import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { Capability } from "../capabilities/Capability";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { ExecutionController } from "../execution/ExecutionController";
import { Executor } from "../execution/Executor";
import { success } from "../execution/TaskResult";
import { LandmarkMemory } from "../memory/LandmarkMemory";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { SkillLoader } from "../skills/SkillLoader";
import { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueries } from "../world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../world/queries/defaultQueries";
import { AgentToolBridge } from "./AgentToolBridge";

const world: WorldQueries = {
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

test("bridge enforces permissions, validation, and revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-bridge-"));
  try {
    const capabilities = new CapabilityRegistry();
    const capability: Capability<{ value: number }, null> = {
      name: "test_action",
      description: "Perform one test action.",
      inputSchema: z.object({ value: z.number().int() }).strict(),
      execute: async () => success(null),
    };
    capabilities.register(capability);
    capabilities.register({
      name: "hidden_action",
      description: "A capability that was not requested.",
      inputSchema: z
        .object({ hiddenDistinctiveField: z.string() })
        .strict(),
      execute: async () => success(null),
    });
    const queries = createDefaultWorldQueryRegistry(world);
    const skills = await SkillRegistry.discover(
      resolve(process.cwd(), "skills"),
    );
    const landmarks = await LandmarkMemory.load(
      join(root, "landmarks.json"),
    );
    const controller = new ExecutionController({
      executor: new Executor({
        registry: capabilities,
        runtime: {} as MinecraftRuntime,
        world,
      }),
    });
    const bridge = new AgentToolBridge({
      controller,
      capabilities,
      queries,
      skills,
      skillLoader: new SkillLoader(skills, capabilities, queries),
      landmarks,
    });

    const denied = await bridge.execute(
      call("enqueue_tasks", {
        tasks: [{ capability: "test_action", input: { value: 1 } }],
        expectedRevision: 0,
      }),
      context("readonly"),
    );
    assert.equal(denied.ok, false);
    assert.equal(controller.snapshot().pending.length, 0);

    const enqueued = await bridge.execute(
      call("enqueue_tasks", {
        tasks: [{ capability: "test_action", input: { value: 1 } }],
        expectedRevision: 0,
      }),
      context("planning_stopped"),
    );
    assert.equal(enqueued.ok, true);
    assert.equal(controller.snapshot().pending.length, 1);

    const schemas = await bridge.execute(
      call("get_capability_schemas", { names: ["test_action"] }),
      context("readonly"),
    );
    assert.equal(schemas.ok, true);
    assert.match(schemas.content, /test_action/);
    assert.match(schemas.content, /value/);
    assert.doesNotMatch(schemas.content, /hiddenDistinctiveField/);

    const unknownSchema = await bridge.execute(
      call("get_capability_schemas", { names: ["missing_action"] }),
      context("readonly"),
    );
    assert.equal(unknownSchema.ok, false);
    assert.match(unknownSchema.content, /UNKNOWN_CAPABILITY/);

    const tooManySchemas = await bridge.execute(
      call("get_capability_schemas", {
        names: ["one", "two", "three", "four", "five"],
      }),
      context("readonly"),
    );
    assert.equal(tooManySchemas.ok, false);
    assert.match(tooManySchemas.content, /INVALID_ARGUMENT/);

    const directCapability = await bridge.execute(
      call("test_action", { value: 1 }),
      context("acting"),
    );
    assert.equal(directCapability.ok, false);
    assert.match(directCapability.content, /CAPABILITY_REQUIRES_QUEUE/);
    assert.match(directCapability.content, /enqueue_tasks/);

    for (const permission of [
      "planning_stopped",
      "resume_review",
    ] as const) {
      const refusedResume = await bridge.execute(
        call("resume_execution", {
          expectedRevision: controller.snapshot().revision,
        }),
        {
          permission,
          manualStopped: true,
          generationId: 1,
        },
      );
      assert.equal(refusedResume.ok, false);
      assert.match(refusedResume.content, /PERMISSION_DENIED/);
    }

    const stale = await bridge.execute(
      call("clear_pending_tasks", { expectedRevision: 0 }),
      context("acting"),
    );
    assert.equal(stale.ok, false);
    assert.match(stale.content, /REVISION_CONFLICT/);

    const revision = controller.snapshot().revision;
    const invalidAtomicReplace = await bridge.execute(
      call("replace_pending_tasks", {
        tasks: [
          { capability: "test_action", input: { value: 2 } },
          { capability: "test_action", input: { value: "bad" } },
        ],
        expectedRevision: revision,
      }),
      context("acting"),
    );
    assert.equal(invalidAtomicReplace.ok, false);
    assert.equal(controller.snapshot().revision, revision);
    assert.equal(controller.snapshot().pending.length, 1);

    const readonlyCatalog = bridge.catalog.build("readonly");
    assert.equal(
      readonlyCatalog.some((tool) => tool.name === "enqueue_tasks"),
      false,
    );
    assert.equal(
      readonlyCatalog.some((tool) => tool.name === "get_self"),
      true,
    );
    assert.equal(
      readonlyCatalog.some(
        (tool) => tool.name === "get_capability_schemas",
      ),
      true,
    );

    const actingCatalog = bridge.catalog.build("acting");
    const serializedCatalog = JSON.stringify(actingCatalog);
    assert.ok(
      serializedCatalog.length < 10_000,
      `Acting catalog is unexpectedly large: ${serializedCatalog.length} chars.`,
    );
    assert.doesNotMatch(serializedCatalog, /hiddenDistinctiveField/);
    for (const queueTool of [
      "enqueue_tasks",
      "replace_pending_tasks",
      "prepend_task",
    ]) {
      const tool = actingCatalog.find(({ name }) => name === queueTool);
      assert.ok(tool);
      assert.doesNotMatch(JSON.stringify(tool.parameters), /oneOf/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge returns structured errors for malformed JSON and forged tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-bridge-"));
  try {
    const capabilities = new CapabilityRegistry();
    const queries = createDefaultWorldQueryRegistry(world);
    const skills = await SkillRegistry.discover(
      resolve(process.cwd(), "skills"),
    );
    const landmarks = await LandmarkMemory.load(
      join(root, "landmarks.json"),
    );
    const controller = new ExecutionController({
      executor: new Executor({
        registry: capabilities,
        runtime: {} as MinecraftRuntime,
        world,
      }),
    });
    const bridge = new AgentToolBridge({
      controller,
      capabilities,
      queries,
      skills,
      skillLoader: new SkillLoader(skills, capabilities, queries),
      landmarks,
    });

    const malformed = await bridge.execute(
      { id: "bad", name: "get_self", arguments: "{" },
      context("readonly"),
    );
    assert.equal(malformed.ok, false);
    assert.match(malformed.content, /valid JSON/);

    const forged = await bridge.execute(
      { id: "forged", name: "delete_world", arguments: "{}" },
      context("acting"),
    );
    assert.equal(forged.ok, false);
    assert.match(forged.content, /TOOL_NOT_FOUND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function call(name: string, argumentsValue: unknown) {
  return {
    id: `call-${name}`,
    name,
    arguments: JSON.stringify(argumentsValue),
  };
}

function context(
  permission: "readonly" | "planning_stopped" | "acting",
) {
  return {
    permission,
    manualStopped: false,
    generationId: 1,
  } as const;
}
