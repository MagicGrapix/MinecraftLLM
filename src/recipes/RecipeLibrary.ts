import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type MinecraftData from "minecraft-data";
import { RECIPE_LIMITS } from "../config";
import { relevance } from "../world/MaterialCatalog";
import { ItemNameSchema, RecipeFileSchema, ingredientCounts, type RecipeFile } from "./RecipeSchema";

export type RecipeIssueCode = "RECIPE_MISSING" | "INVALID_RECIPE_FILE" | "UNKNOWN_ITEM" | "VERSION_MISMATCH" | "RECIPE_NOT_RECOGNIZED" | "UNSUPPORTED_RECIPE" | "INVALID_ARGUMENT" | "RESULT_TOO_LARGE";
export class RecipeIssue extends Error {
  constructor(readonly code: RecipeIssueCode, message: string) { super(message); }
}
export const MISSING_RECIPE_MESSAGE = "No recipe found in the current recipe library. This does not mean the item cannot be crafted or obtained.";

/** Startup snapshot of curated knowledge, independent of Mineflayer's inventory/table filters. */
export class RecipeLibrary {
  private readonly files = new Map<string, RecipeFile>();
  private readonly issues = new Map<string, RecipeIssue>();
  private constructor(private readonly data: ReturnType<typeof MinecraftData>) {}

  static async load(directory: string, data: ReturnType<typeof MinecraftData>): Promise<RecipeLibrary> {
    const library = new RecipeLibrary(data);
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".json")).sort()) {
      const item = file.slice(0, -5);
      if (!ItemNameSchema.safeParse(item).success) throw new Error(`Invalid recipe filename: ${file}`);
      try {
        const path = join(directory, file);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > RECIPE_LIMITS.maxFileBytes) throw new RecipeIssue("INVALID_RECIPE_FILE", "Expected a regular JSON file within the recipe size limit.");
        const recipe = validateRecipe(JSON.parse(await readFile(path, "utf8")), item, data);
        library.files.set(item, recipe);
      } catch (error) {
        const issue = error instanceof RecipeIssue ? error : new RecipeIssue("INVALID_RECIPE_FILE", (error as Error).message);
        library.issues.set(item, new RecipeIssue(issue.code, `${file}: ${issue.message}`));
      }
    }
    return library;
  }

  diagnostics(): readonly { item: string; code: RecipeIssueCode; message: string }[] {
    return [...this.issues].map(([item, error]) => ({ item, code: error.code, message: error.message }));
  }

  read(item: string): RecipeFile {
    if (!ItemNameSchema.safeParse(item).success) throw new RecipeIssue("INVALID_ARGUMENT", "Use an exact item name, never a filename or path.");
    const issue = this.issues.get(item);
    if (issue) throw issue;
    if (!Object.hasOwn(this.data.itemsByName, item)) throw new RecipeIssue("UNKNOWN_ITEM", `Unknown Minecraft item "${item}". Use search_recipes for documented names.`);
    const recipe = this.files.get(item);
    if (!recipe) throw new RecipeIssue("RECIPE_MISSING", MISSING_RECIPE_MESSAGE);
    return structuredClone(recipe);
  }

  search(query: string) {
    const needle = query.trim().toLowerCase().replace(/\s+/g, "_");
    if (!needle || needle.length > 128) throw new RecipeIssue("INVALID_ARGUMENT", "Query must contain 1–128 characters.");
    const matches = [...this.files.values()].map(file => ({ file, score: relevance(needle, file.item) }))
      .filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.file.item.localeCompare(b.file.item));
    return {
      matches: matches.slice(0, RECIPE_LIMITS.searchResults).map(({ file }) => ({
        item: file.item, variants: file.variants.length,
        preview: `${file.item} x${file.variants[0]!.outputCount} | ${file.variants[0]!.station}`,
      })),
      total: matches.length, truncated: matches.length > RECIPE_LIMITS.searchResults,
    };
  }
}

export function validateRecipe(raw: unknown, filename: string, data: ReturnType<typeof MinecraftData>): RecipeFile {
  // Distinguish unsupported production methods from malformed supported recipes.
  if (typeof raw === "object" && raw !== null && "variants" in raw && Array.isArray(raw.variants) &&
    raw.variants.some(v => v && typeof v.type === "string" && !["shaped", "shapeless"].includes(v.type))) {
    throw new RecipeIssue("UNSUPPORTED_RECIPE", "Only shaped and shapeless crafting recipes are supported.");
  }
  const parsed = RecipeFileSchema.safeParse(raw);
  if (!parsed.success) throw new RecipeIssue("INVALID_RECIPE_FILE", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const file = parsed.data;
  if (file.item !== filename) throw new RecipeIssue("INVALID_RECIPE_FILE", "item must equal the filename without .json.");
  if (file.minecraftVersion !== data.version.minecraftVersion) throw new RecipeIssue("VERSION_MISMATCH", `minecraftVersion: expected ${data.version.minecraftVersion}, received ${file.minecraftVersion}.`);
  const output = Object.hasOwn(data.itemsByName, file.item) ? data.itemsByName[file.item] : undefined;
  if (!output) throw new RecipeIssue("UNKNOWN_ITEM", `item: unknown Minecraft name "${file.item}".`);
  file.variants.forEach((variant, index) => {
    const field = `variants.${index}`;
    if (variant.type === "shaped") {
      const width = variant.rows[0]!.length;
      const used = new Set(variant.rows.join("").replaceAll(".", ""));
      if (!used.size || variant.rows.some(row => row.length !== width)) throw new RecipeIssue("INVALID_RECIPE_FILE", `${field}.rows: expected a nonempty rectangular pattern.`);
      if ([...used].some(c => !variant.palette[c]) || Object.keys(variant.palette).some(c => !used.has(c))) throw new RecipeIssue("INVALID_RECIPE_FILE", `${field}.palette: must define exactly the nonempty symbols used in rows.`);
      if (new Set(Object.values(variant.palette)).size !== Object.keys(variant.palette).length) throw new RecipeIssue("INVALID_RECIPE_FILE", `${field}.palette: use one symbol per ingredient name.`);
    }
    const counts = ingredientCounts(variant);
    for (const name of Object.keys(counts)) if (!Object.hasOwn(data.itemsByName, name)) throw new RecipeIssue("UNKNOWN_ITEM", `${field}: unknown ingredient "${name}".`);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 9) throw new RecipeIssue("INVALID_RECIPE_FILE", `${field}.ingredients: crafting has at most nine slots.`);
    const matrix = variant.type === "shaped" ? trimShape(variant.rows.map(row => [...row].map(c => c === "." ? null : data.itemsByName[variant.palette[c]!]!.id))) : undefined;
    const table = matrix ? matrix.length > 2 || matrix[0]!.length > 2 : total > 4;
    if (variant.station !== (table ? "crafting_table" : "inventory")) throw new RecipeIssue("INVALID_RECIPE_FILE", `${field}.station: must identify the minimum crafting grid.`);
    let unsupported = false;
    const matches = (data.recipes[output.id] ?? []).some(recipe => {
      if ("outShape" in recipe && recipe.outShape) { unsupported = true; return false; }
      try {
        const result = catalogItem(recipe.result);
        if (result.id !== output.id || result.count !== variant.outputCount) return false;
        if (matrix && "inShape" in recipe) {
          const expected = trimShape(recipe.inShape.map(row => row.map(cell => {
            const item = catalogItem(cell);
            if (item.count !== 1) throw new Error("Unsupported ingredient count");
            return item.id;
          })));
          return equal(matrix, expected) || equal(matrix, expected.map(row => [...row].reverse()));
        }
        if (!matrix && "ingredients" in recipe) {
          const expected: Record<string, number> = {};
          for (const cell of recipe.ingredients) {
            const item = catalogItem(cell);
            if (item.id === null || !data.items[item.id]) throw new Error("Unknown catalog ingredient");
            const name = data.items[item.id]!.name;
            expected[name] = (expected[name] ?? 0) + item.count;
          }
          return equalCounts(counts, expected);
        }
        return false;
      } catch { unsupported = true; return false; }
    });
    if (!matches) throw new RecipeIssue(unsupported ? "UNSUPPORTED_RECIPE" : "RECIPE_NOT_RECOGNIZED", `${field}: no matching supported ${file.item} recipe in the ${file.minecraftVersion} catalog (check shape, ingredients and outputCount). Datapacks are not included.`);
  });
  return file;
}

function catalogItem(item: MinecraftData.RecipeItem): { id: number | null; count: number } {
  if (item === null || typeof item === "number") return { id: item, count: 1 };
  if (Array.isArray(item)) {
    if (item[1] !== undefined && item[1] !== 0) throw new Error("Metadata-specific recipes are unsupported");
    return { id: item[0] ?? null, count: 1 };
  }
  if (item.metadata !== undefined && item.metadata !== 0) throw new Error("Metadata-specific recipes are unsupported");
  return { id: item.id, count: item.count ?? 1 };
}

function trimShape(shape: (number | null)[][]): (number | null)[][] {
  const occupied = shape.flatMap((row, z) => row.flatMap((cell, x) => cell === null ? [] : [{ x, z }]));
  if (!occupied.length) return [];
  const minX = Math.min(...occupied.map(p => p.x)), maxX = Math.max(...occupied.map(p => p.x));
  const minZ = Math.min(...occupied.map(p => p.z)), maxZ = Math.max(...occupied.map(p => p.z));
  return shape.slice(minZ, maxZ + 1).map(row => Array.from({ length: maxX - minX + 1 }, (_, i) => row[minX + i] ?? null));
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function equalCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  return equal(Object.entries(a).sort(), Object.entries(b).sort());
}
