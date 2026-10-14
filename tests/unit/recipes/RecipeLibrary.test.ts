import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import MinecraftData from "minecraft-data";
import { RECIPE_LIMITS } from "../../../src/config";
import { RecipeIssue, RecipeLibrary, validateRecipe } from "../../../src/recipes/RecipeLibrary";
import { renderRecipe } from "../../../src/recipes/RecipeRenderer";
import { RecipeTools } from "../../../src/recipes/RecipeTools";

const data = MinecraftData("1.21.11");
const library = () => RecipeLibrary.load(resolve("recipes"), data);
const fixture = async (name = "wooden_axe"): Promise<any> => JSON.parse(await readFile(resolve("recipes", `${name}.json`), "utf8"));

test("all eight initial files match the version catalog without an inventory or table", async () => {
  const l = await library();
  assert.deepEqual(l.diagnostics(), []);
  for (const name of ["oak_planks", "stick", "crafting_table", "wooden_axe", "wooden_pickaxe", "wooden_sword", "stone_pickaxe", "furnace"]) {
    assert.equal(l.read(name).item, name);
  }
  const tools = new RecipeTools(l);
  const axe = tools.execute("read_recipe", { item: "wooden_axe" });
  assert.equal(axe.result.ok, true);
  assert.match(axe.feedback, /wooden_axe x1 per craft/);
  assert.match(axe.feedback, /Grid: 3x3 \| Station: crafting_table/);
  assert.match(axe.feedback, /A = oak_planks x3\nB = stick x2/);
  assert.match(axe.feedback, /\[A\] \[A\] \[ \]\n\[A\] \[B\] \[ \]\n\[ \] \[B\] \[ \]/);
});

test("whole craft yields, variants and shapeless placement remain explicit", async () => {
  const tools = new RecipeTools(await library());
  const stick = tools.execute("read_recipe", { item: "stick" });
  assert.match(stick.feedback, /stick x4 per craft/);
  assert.match(stick.feedback, /oak_planks x2/);
  assert.match(stick.feedback, /Other variants: 2: Birch planks/);
  assert.match(tools.execute("read_recipe", { item: "stick", variant: 2 }).feedback, /birch_planks x2/);
  const planks = tools.execute("read_recipe", { item: "oak_planks" });
  assert.match(planks.feedback, /oak_planks x4 per craft/);
  assert.match(planks.feedback, /Placement: any order\noak_log x1/);
  assert.doesNotMatch(planks.feedback, /\[A\]/);
});

const invalidCases: [string, (f: any) => void, string][] = [
  ["wrong shape with correct counts", f => f.variants[0].rows = ["AB", "AB", "A."], "RECIPE_NOT_RECOGNIZED"],
  ["wrong yield", f => f.variants[0].outputCount = 2, "RECIPE_NOT_RECOGNIZED"],
  ["wrong station", f => f.variants[0].station = "inventory", "INVALID_RECIPE_FILE"],
  ["undefined symbol", f => f.variants[0].rows[0] = "AC", "INVALID_RECIPE_FILE"],
  ["unused symbol", f => f.variants[0].palette.C = "dirt", "INVALID_RECIPE_FILE"],
  ["nonrectangular shape", f => f.variants[0].rows[0] = "A", "INVALID_RECIPE_FILE"],
  ["unknown ingredient", f => f.variants[0].palette.A = "oak_plate", "UNKNOWN_ITEM"],
  ["version mismatch", f => f.minecraftVersion = "1.20.4", "VERSION_MISMATCH"],
  ["unsupported smelting", f => f.variants[0].type = "smelting", "UNSUPPORTED_RECIPE"],
  ["filename mismatch", f => f.item = "wooden_sword", "INVALID_RECIPE_FILE"],
  ["empty pattern", f => { f.variants[0].rows = [".."]; f.variants[0].palette = {}; }, "INVALID_RECIPE_FILE"],
];
for (const [name, mutate, code] of invalidCases) test(`catalog validation rejects ${name}`, async () => {
  const file = await fixture(); mutate(file);
  assert.throws(() => validateRecipe(file, "wooden_axe", data), (e: unknown) => e instanceof RecipeIssue && e.code === code);
});

test("mirrored recipes validate and translated padding does not clip the rendered minimum grid", async () => {
  const axe = await fixture(); axe.variants[0].rows = ["AA", "BA", "B."];
  assert.equal(validateRecipe(axe, "wooden_axe", data).variants.length, 1);
  const sticks = await fixture("stick"); sticks.variants[0].rows = ["...", "..A", "..A"];
  const validated = validateRecipe(sticks, "stick", data);
  assert.match(renderRecipe(validated, 1), /\[A\] \[ \]\n\[A\] \[ \]/);
});

test("missing knowledge is distinct from an unknown name and a rejected path", async () => {
  const tools = new RecipeTools(await library());
  const missing = tools.execute("read_recipe", { item: "diamond_axe" });
  assert.ok(!missing.result.ok && missing.result.error.code === "RECIPE_MISSING");
  assert.match(missing.feedback, /does not mean the item cannot be crafted or obtained/);
  const unknown = tools.execute("read_recipe", { item: "wooden_ax" });
  assert.ok(!unknown.result.ok && unknown.result.error.code === "UNKNOWN_ITEM");
  assert.match(unknown.feedback, /wooden_axe/);
  for (const item of ["../config", "C:\\secret", "wooden_axe.json", "minecraft:wooden_axe"]) {
    const result = tools.execute("read_recipe", { item });
    assert.ok(!result.result.ok && result.result.error.code === "INVALID_ARGUMENT");
  }
  assert.equal(tools.execute("read_recipe", { item: "__proto__" }).result.ok, false);
  assert.equal(tools.execute("read_recipe", { item: "wooden_axe", variant: 0 }).result.ok, false);
  assert.equal(tools.execute("read_recipe", { item: "wooden_axe", variant: 2 }).result.ok, false);
});

test("search is lexical, bounded and only returns documented entries", async () => {
  const l = await library();
  assert.equal(l.search("axe").matches[0]!.item, "wooden_axe");
  assert.equal(l.search("wooden_ax").matches[0]!.item, "wooden_axe");
  assert.equal(l.search("wooden axe").matches[0]!.item, "wooden_axe");
  assert.ok(l.search("diamond").matches.every(m => m.item !== "diamond_axe"));
  const previous = RECIPE_LIMITS.searchResults;
  try {
    RECIPE_LIMITS.searchResults = 1;
    assert.equal(l.search("wooden").matches.length, 1);
    assert.equal(l.search("wooden").total, 3);
    assert.equal(l.search("wooden").truncated, true);
  } finally { RECIPE_LIMITS.searchResults = previous; }
  assert.equal(new RecipeTools(l).execute("search_recipes", { query: "x".repeat(129) }).result.ok, false);
});

test("loading retains field diagnostics and snapshots, not changed files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "recipe-library-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = await fixture();
  await writeFile(join(directory, "wooden_axe.json"), JSON.stringify(file));
  await writeFile(join(directory, "stick.json"), "{broken");
  const l = await RecipeLibrary.load(directory, data);
  assert.equal(l.diagnostics()[0]!.item, "stick");
  assert.match(l.diagnostics()[0]!.message, /stick.json:/);
  assert.throws(() => l.read("stick"), (e: unknown) => e instanceof RecipeIssue && e.code === "INVALID_RECIPE_FILE");
  file.variants[0].outputCount = 2;
  await writeFile(join(directory, "wooden_axe.json"), JSON.stringify(file));
  assert.equal(l.read("wooden_axe").variants[0]!.outputCount, 1);
  l.read("wooden_axe").variants[0]!.outputCount = 7;
  assert.equal(l.read("wooden_axe").variants[0]!.outputCount, 1);
  assert.equal((await RecipeLibrary.load(directory, data)).diagnostics().length, 2);
});

test("unsupported catalog remainders are not silently discarded", async () => {
  const custom = { ...data, recipes: { ...data.recipes } };
  const id = data.itemsByName.wooden_axe!.id;
  custom.recipes[id] = data.recipes[id]!.map(r => ({ ...r, outShape: [[data.itemsByName.stick!.id]] } as MinecraftData.Recipe));
  const file = await fixture();
  assert.throws(() => validateRecipe(file, "wooden_axe", custom), (e: unknown) => e instanceof RecipeIssue && e.code === "UNSUPPORTED_RECIPE");
});

test("oversized results fail explicitly rather than truncating a grid", async () => {
  const tools = new RecipeTools(await library());
  const previous = RECIPE_LIMITS.maxResultChars;
  try {
    RECIPE_LIMITS.maxResultChars = 100;
    const result = tools.execute("read_recipe", { item: "wooden_axe" });
    assert.ok(!result.result.ok && result.result.error.code === "RESULT_TOO_LARGE");
    assert.doesNotMatch(result.feedback, /\[A\]/);
  } finally { RECIPE_LIMITS.maxResultChars = previous; }
});
