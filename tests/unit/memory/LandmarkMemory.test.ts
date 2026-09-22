import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LandmarkMemory } from "../../../src/memory/LandmarkMemory";

test("landmarks persist atomically and can be reloaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-landmarks-"));
  const file = join(root, "data", "landmarks.json");
  try {
    const memory = await LandmarkMemory.load(file, {
      createId: () => "landmark-1",
      now: () => 100,
    });
    await memory.remember({
      name: "Maison",
      kind: "base",
      dimension: "overworld",
      position: { x: 1, y: 64, z: 2 },
      source: "user",
      pinned: true,
    });

    const reloaded = await LandmarkMemory.load(file);
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.pinned()[0]?.name, "Maison");
    assert.match(await readFile(file, "utf8"), /"version": 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt landmark data is backed up instead of overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-landmarks-"));
  const file = join(root, "landmarks.json");
  try {
    await writeFile(file, "{bad-json", "utf8");
    await assert.rejects(
      LandmarkMemory.load(file),
      /moved to/,
    );
    const files = await readdir(root);
    assert.equal(
      files.some((name) => name.startsWith("landmarks.json.corrupt-")),
      true,
    );
    assert.equal(files.includes("landmarks.json"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("block landmarks become stale when unloaded and missing only after verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-landmarks-"));
  try {
    const memory = await LandmarkMemory.load(
      join(root, "landmarks.json"),
      { createId: () => "table-id", now: () => 200 },
    );
    await memory.remember({
      name: "Table",
      kind: "crafting_table",
      dimension: "overworld",
      position: { x: 3, y: 64, z: 4 },
      source: "observed",
      pinned: true,
    });

    await memory.verifyBlock(
      "overworld",
      { x: 3, y: 64, z: 4 },
      null,
      false,
    );
    assert.equal(memory.list()[0]?.status, "stale");

    await memory.verifyBlock(
      "overworld",
      { x: 3, y: 64, z: 4 },
      "air",
      true,
    );
    assert.equal(memory.list()[0]?.status, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent landmark mutations persist in call order", async () => {
  const root = await mkdtemp(join(tmpdir(), "minecraft-landmarks-"));
  const file = join(root, "landmarks.json");
  try {
    let nextId = 0;
    const memory = await LandmarkMemory.load(file, {
      createId: () => `landmark-${++nextId}`,
      now: () => 300,
    });

    await Promise.all([
      memory.remember({
        name: "Table",
        kind: "crafting_table",
        dimension: "overworld",
        position: { x: 1, y: 64, z: 1 },
        source: "observed",
        pinned: true,
      }),
      memory.remember({
        name: "Coffre",
        kind: "chest",
        dimension: "overworld",
        position: { x: 2, y: 64, z: 2 },
        source: "observed",
        pinned: true,
      }),
    ]);

    const reloaded = await LandmarkMemory.load(file);
    assert.deepEqual(
      reloaded.list().map((landmark) => landmark.name),
      ["Coffre", "Table"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
