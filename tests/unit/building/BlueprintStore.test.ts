import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import minecraftData from "minecraft-data";
import { BlueprintStore } from "../../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { BLUEPRINT_LIMITS } from "../../../src/building/BuildingConfig";
import type { TaskResult } from "../../../src/execution/TaskResult";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { blueprintFixture } from "../../support/blueprints";

const registry = minecraftData("1.21.11");
const validator = new BlueprintValidator(new MaterialCatalog(registry));
const fixedId = "bp_12345678-1234-1234-1234-123456789abc";

test("store publishes normalized JSON and a new instance revalidates it without Minecraft", async (t) => {
  const { store, directory } = await setup(t);
  const blueprint = await blueprintFixture();
  blueprint.palette.A = "minecraft:oak_planks";
  const saved = value(await store.save(blueprint));
  assert.match(saved.id, /^bp_[0-9a-f-]+$/);
  const files = await readdir(directory);
  assert.deepEqual(files, [`${saved.id}.json`]);
  const json = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
  assert.equal(json.formatVersion, 1);
  assert.equal(json.minecraftVersion, "1.21.11");
  assert.equal(json.blueprint.palette.A, "oak_planks");
  assert.equal(json.cells, undefined, "derived cell lists are recompiled, not duplicated on disk");
  assert.deepEqual(value(await new BlueprintStore(validator, { directory }).load(saved.id)), saved);
  saved.blueprint.palette.A = "sand";
  assert.equal(value(await store.load(saved.id)).blueprint.palette.A, "oak_planks");
});

test("invalid blueprints, including unsupported doors, are never persisted", async (t) => {
  const { store, root } = await setup(t);
  const result = await store.save(await blueprintFixture(true));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.facts?.reason, "INVALID_BLUEPRINT");
  assert.deepEqual(await readdir(root), []);
});

test("revision creates another reference without changing the original", async (t) => {
  const { store, directory } = await setup(t);
  const original = value(await store.save(await blueprintFixture()));
  const revised = await blueprintFixture();
  revised.palette.A = "birch_planks";
  const second = value(await store.save(revised));
  assert.notEqual(original.id, second.id);
  assert.equal(value(await store.load(original.id)).blueprint.palette.A, "oak_planks");
  assert.equal(value(await store.load(second.id)).blueprint.palette.A, "birch_planks");
  assert.equal((await readdir(directory)).length, 2);
});

test("concurrent ID collisions cannot overwrite an already published blueprint", async (t) => {
  const { store, directory } = await setup(t, () => fixedId);
  const first = await blueprintFixture();
  const second = await blueprintFixture();
  second.name = "different";
  const results = await Promise.all([store.save(first), store.save(second)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const winner = results.find((result) => result.ok)!;
  assert.deepEqual(value(await store.load(fixedId)), value(winner));
  assert.deepEqual(await readdir(directory), [`${fixedId}.json`]);
  const before = await readFile(join(directory, `${fixedId}.json`), "utf8");
  assert.equal((await store.save(second)).ok, false);
  assert.equal(await readFile(join(directory, `${fixedId}.json`), "utf8"), before);
});

test("paths and unsafe IDs are rejected before accessing files", async (t) => {
  const { store, root } = await setup(t);
  for (const id of ["../secrets", "bp_../secrets", "C:\\secrets", "CON", "bp:alternate", "small_oak_shelter", ""]) {
    const result = await store.load(id);
    assert.equal(result.ok, false, id);
    if (!result.ok) assert.equal(result.error.facts?.reason, "INVALID_BLUEPRINT_ID");
  }
  assert.deepEqual(await readdir(root), []);
});

test("missing references return TARGET_NOT_FOUND without creating a directory", async (t) => {
  const { store, root } = await setup(t);
  const result = await store.load(fixedId);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TARGET_NOT_FOUND");
  assert.deepEqual(await readdir(root), []);
});

test("invalid ID generation cannot escape the configured directory", async (t) => {
  const { store, root } = await setup(t, () => "../outside");
  const result = await store.save(await blueprintFixture());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.facts?.reason, "INVALID_BLUEPRINT_ID");
  assert.deepEqual(await readdir(root), []);
});

test("invalid JSON is reported and left untouched for inspection", async (t) => {
  const { store, directory } = await setup(t);
  const saved = value(await store.save(await blueprintFixture()));
  const path = join(directory, `${saved.id}.json`);
  await writeFile(path, "{bad-json", "utf8");
  const result = await store.load(saved.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.facts?.reason, "INVALID_BLUEPRINT_FILE");
  assert.equal(await readFile(path, "utf8"), "{bad-json");
});

for (const corruption of ["format", "id", "materials", "envelope", "drawing"] as const) {
  test(`reloading rejects corrupted ${corruption} rather than trusting stored metadata`, async (t) => {
    const { store, directory } = await setup(t);
    const saved = value(await store.save(await blueprintFixture()));
    const path = join(directory, `${saved.id}.json`);
    const edited = JSON.parse(await readFile(path, "utf8"));
    switch (corruption) {
      case "format": edited.formatVersion = 999; break;
      case "id": edited.id = fixedId; break;
      case "materials": edited.materials[0].quantity = 1; break;
      case "envelope": edited.extra = true; break;
      case "drawing": edited.blueprint.layers[0][0] = "Z"; break;
    }
    const text = JSON.stringify(edited);
    await writeFile(path, text, "utf8");
    assert.equal((await store.load(saved.id)).ok, false);
    assert.equal(await readFile(path, "utf8"), text);
  });
}

test("Minecraft version mismatch requires explicit resubmission", async (t) => {
  const { store, directory } = await setup(t);
  const saved = value(await store.save(await blueprintFixture()));
  const otherRegistry = { ...registry, version: { minecraftVersion: "different-version" } };
  const other = new BlueprintStore(new BlueprintValidator(new MaterialCatalog(otherRegistry)), { directory });
  const result = await other.load(saved.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.facts?.reason, "BLUEPRINT_VERSION_MISMATCH");
});

test("same-version registry changes are still checked on every read", async (t) => {
  const { store, directory } = await setup(t);
  const saved = value(await store.save(await blueprintFixture()));
  const itemsByName = { ...registry.itemsByName };
  delete itemsByName.oak_planks;
  const other = new BlueprintStore(new BlueprintValidator(new MaterialCatalog({ ...registry, itemsByName })), { directory });
  assert.equal((await other.load(saved.id)).ok, false);
});

test("oversized files are refused without rewriting them", async (t) => {
  const { store, directory } = await setup(t);
  const saved = value(await store.save(await blueprintFixture()));
  const path = join(directory, `${saved.id}.json`);
  const oversized = " ".repeat(BLUEPRINT_LIMITS.maxFileBytes + 1);
  await writeFile(path, oversized, "utf8");
  const result = await store.load(saved.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.facts?.reason, "INVALID_BLUEPRINT_FILE");
  assert.equal((await readFile(path)).length, oversized.length);
});

test("filesystem failures produce structured errors without touching existing content", async (t) => {
  const { root } = await setup(t);
  const path = join(root, "not-a-directory");
  await writeFile(path, "preserve me", "utf8");
  const store = new BlueprintStore(validator, { directory: path });
  const result = await store.save(await blueprintFixture());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.facts?.reason, "BLUEPRINT_IO_ERROR");
  assert.equal(await readFile(path, "utf8"), "preserve me");
});

async function setup(t: TestContext, createId?: () => string) {
  const root = await mkdtemp(join(tmpdir(), "minecraft-blueprint-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "blueprints");
  return { root, directory, store: new BlueprintStore(validator, { directory, createId }) };
}

function value<T>(result: TaskResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}
