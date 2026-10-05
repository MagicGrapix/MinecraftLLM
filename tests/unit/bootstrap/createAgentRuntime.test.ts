import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ActionTaskOutcome } from "../../../src/agent/ActionTypes";
import { success, type TaskResult } from "../../../src/execution/TaskResult";
import { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { refreshLandmarksFromTask } from "../../../src/bootstrap/createAgentRuntime";
import type { BlockInfo } from "../../../src/world/types";

test("successful place confirms its result position and dig invalidates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-agent-runtime-"));
  try {
    const memory = await LandmarkMemory.load(
      join(root, "landmarks.json"),
      { createId: () => "table-id", now: () => 500 },
    );
    const placedPosition = { x: 3, y: 64, z: 4 };
    let name = "crafting_table";
    const world = { getBlock: () => ({ name } as BlockInfo) };
    await memory.remember({
      name: "Table",
      kind: "crafting_table",
      dimension: "overworld",
      position: placedPosition,
      source: "observed",
      pinned: true,
    });
    await memory.markStatus("table-id", "stale");

    await refreshLandmarksFromTask(
      taskFinished(
        "place",
        {
          referencePosition: { x: 3, y: 63, z: 4 },
          face: "top",
        },
        success({ item: "crafting_table", position: placedPosition }),
      ),
      "overworld",
      memory,
      world,
    );
    assert.equal(memory.list()[0]?.status, "confirmed");

    await memory.markStatus("table-id", "stale");
    await refreshLandmarksFromTask(
      taskFinished("craft_from_table_3x3", { item: "wooden_pickaxe", quantity: 1, tablePosition: placedPosition },
        success({ item: "wooden_pickaxe", craftedQuantity: 1, station: "crafting_table" })),
      "overworld", memory, world,
    );
    assert.equal(memory.list()[0]?.status, "confirmed");

    name = "air";
    await refreshLandmarksFromTask(
      taskFinished(
        "dig",
        { position: placedPosition },
        success({ position: placedPosition, block: "crafting_table" }),
      ),
      "overworld",
      memory,
      world,
    );
    assert.equal(memory.list()[0]?.status, "missing");
    name = "dirt";
    await refreshLandmarksFromTask(taskFinished("place", {}, success({ position: placedPosition })), "overworld", memory, world);
    assert.equal(memory.list()[0]?.status, "missing", "Placing dirt does not confirm a remembered crafting table.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function taskFinished(
  capability: string,
  input: unknown,
  result: TaskResult,
): ActionTaskOutcome {
  return {
    task: {
      id: `task-${capability}`,
      capability,
      input,
      createdAt: 1,
    },
    result,
  };
}
