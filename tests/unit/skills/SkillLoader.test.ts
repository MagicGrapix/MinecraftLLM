import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { Capability } from "../../../src/capabilities/Capability";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { success } from "../../../src/execution/TaskResult";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";
import { SkillLoader } from "../../../src/skills/SkillLoader";
import { SkillRegistry } from "../../../src/skills/SkillRegistry";

const emptyWorld: WorldQueries = {
  getSelf: () => ({
    position: { x: 0, y: 0, z: 0 },
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

test("gather can be listed as a summary and loaded with full instructions", async () => {
  const registry = await SkillRegistry.discover(
    resolve(process.cwd(), "skills"),
  );
  const loader = new SkillLoader(
    registry,
    capabilities("goto", "equip", "dig"),
    createDefaultWorldQueryRegistry(emptyWorld),
  );

  const summaries = registry.list();
  const gatherSummary = summaries.find((skill) => skill.name === "gather");
  assert.deepEqual(gatherSummary, {
    name: "gather",
    description:
      "Gather a requested quantity of a resource found in the world.",
  });

  const gather = await loader.load("gather");
  assert.deepEqual(gather.requiredCapabilities, ["goto", "equip", "dig"]);
  assert.deepEqual(gather.requiredQueries, [
    "get_inventory",
    "find_nearest_blocks",
    "get_nearby_entities",
  ]);
  assert.match(gather.instructions, /Success condition/);
  assert.match(gather.instructions, /droppedItem/);
  assert.match(gather.instructions, /continue_plan/);
  assert.doesNotMatch(gather.instructions, /enqueue_tasks/);
});

test("craft and hunger skills load as text-only instructions", async () => {
  const registry = await SkillRegistry.discover(
    resolve(process.cwd(), "skills"),
  );
  const loader = new SkillLoader(
    registry,
    capabilities("goto", "equip", "craft", "consume"),
    createDefaultWorldQueryRegistry(emptyWorld),
  );

  const craft = await loader.load("craft_item");
  const hunger = await loader.load("eat_when_hungry");

  assert.deepEqual(craft.requiredCapabilities, ["goto", "craft"]);
  assert.match(craft.instructions, /3x3\s+recipe/);
  assert.deepEqual(hunger.requiredCapabilities, ["equip", "consume"]);
  assert.match(hunger.instructions, /ACTION_NOT_CONFIRMED/);
});

test("loader rejects unsafe names before resolving a path", async () => {
  const registry = await SkillRegistry.discover(
    resolve(process.cwd(), "skills"),
  );
  const loader = new SkillLoader(
    registry,
    capabilities("goto", "equip", "dig"),
    createDefaultWorldQueryRegistry(emptyWorld),
  );

  await assert.rejects(
    loader.load("../outside"),
    /Unsafe skill name/,
  );
});

test("loader detects unavailable capability and query dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-llm-skills-"));

  try {
    await writeSkill(
      root,
      "invalid",
      `---
name: invalid
description: Invalid dependency test.
required_capabilities:
  - missing_capability
required_queries:
  - missing_query
---

# Invalid

Instructions.
`,
    );
    const registry = await SkillRegistry.discover(root);
    const loader = new SkillLoader(
      registry,
      capabilities(),
      createDefaultWorldQueryRegistry(emptyWorld),
    );

    await assert.rejects(
      loader.load("invalid"),
      /Missing capabilities: missing_capability.*Missing queries: missing_query/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry rejects a manifest whose name differs from its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-llm-skills-"));

  try {
    await writeSkill(
      root,
      "directory-name",
      `---
name: different-name
description: Mismatched name.
required_capabilities: []
required_queries: []
---

Instructions.
`,
    );

    await assert.rejects(
      SkillRegistry.discover(root),
      /must match manifest name/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function capabilities(...names: string[]): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const name of names) {
    const capability: Capability<Record<string, never>, null> = {
      name,
      inputSchema: z.object({}).strict(),
      execute: async () => success(null),
    };
    registry.register(capability);
  }
  return registry;
}

async function writeSkill(
  root: string,
  directory: string,
  content: string,
): Promise<void> {
  const skillDirectory = join(root, directory);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), content, "utf8");
}
