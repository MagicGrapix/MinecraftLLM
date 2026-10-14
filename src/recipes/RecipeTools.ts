import { z } from "zod";
import { RECIPE_LIMITS } from "../config";
import type { LLMTool } from "../llm/LLMClient";
import { toJsonSchema } from "../agent/ToolCatalogBuilder";
import { invalidToolArguments } from "../shared/ToolArgumentFeedback";
import { ItemNameSchema, ingredientCounts } from "./RecipeSchema";
import { RecipeLibrary, RecipeIssue, MISSING_RECIPE_MESSAGE } from "./RecipeLibrary";
import { renderRecipe } from "./RecipeRenderer";

export const recipeSchemas = {
  search_recipes: z.object({ query: z.string().trim().min(1).max(128).describe("Item name or words, e.g. wooden axe.") }).strict(),
  read_recipe: z.object({ item: ItemNameSchema.describe("Exact documented item name, e.g. wooden_axe."),
    variant: z.number().int().min(1).max(RECIPE_LIMITS.maxVariants).optional().describe("1-based variant; defaults to 1.") }).strict(),
};
const descriptions = {
  search_recipes: "Does: Find documented crafting recipes by item name, words or spelling similarity.\nSuccess: Returns up to five library entries.\nLimits: Partial knowledge, not a test of craftability or inventory. No match does not mean impossible.\nNotes: Read an exact result with read_recipe.",
  read_recipe: "Does: Read one documented recipe, ingredients, output per craft, station and bracket grid.\nSuccess: Recipe matches the configured Minecraft catalog.\nLimits: Does not check current stock, table access or server datapacks; does not craft.\nNotes: item must be exact. variant is optional and 1-based. Whole batches may produce extra output.",
};
export interface RecipeToolOutcome {
  readonly result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; suggestions?: readonly string[] } };
  readonly feedback: string;
}

/** Shared read-only tools; never registered globally as coordinator world queries. */
export class RecipeTools {
  readonly definitions: readonly LLMTool[] = Object.entries(recipeSchemas).map(([name, schema]) => ({
    name, description: descriptions[name as keyof typeof descriptions], parameters: toJsonSchema(schema),
  }));
  constructor(private readonly library: RecipeLibrary) {}
  schema(name: string): z.ZodTypeAny | undefined {
    return Object.hasOwn(recipeSchemas, name) ? recipeSchemas[name as keyof typeof recipeSchemas] : undefined;
  }
  execute(name: string, raw: unknown): RecipeToolOutcome {
    try {
      const schema = this.schema(name);
      if (!schema) throw new RecipeIssue("INVALID_ARGUMENT", `Unknown recipe tool "${name}".`);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new RecipeIssue("INVALID_ARGUMENT", invalidToolArguments(name, raw, parsed.error.issues, schema));
      if (name === "search_recipes") {
        const found = this.library.search(parsed.data.query);
        const feedback = found.matches.length ? [
          ...found.matches.map(m => `${m.preview} | ${m.variants} variant(s)`),
          ...(found.truncated ? [`Showing ${found.matches.length} of ${found.total} matches; refine the query.`] : []),
          "Partial recipe library; absence is not proof of impossibility.",
        ].join("\n") : MISSING_RECIPE_MESSAGE;
        return this.bounded({ ok: true, value: found }, feedback);
      }
      const file = this.library.read(parsed.data.item);
      const index: number = parsed.data.variant ?? 1;
      const variant = file.variants[index - 1];
      if (!variant) throw new RecipeIssue("INVALID_ARGUMENT", `Variant ${index} does not exist; choose 1–${file.variants.length}.`);
      return this.bounded({ ok: true, value: { item: file.item, variant: index, minecraftVersion: file.minecraftVersion,
        recipe: variant, ingredients: ingredientCounts(variant) } }, renderRecipe(file, index));
    } catch (error) {
      if (!(error instanceof RecipeIssue)) throw error;
      const item = typeof raw === "object" && raw !== null && "item" in raw && typeof raw.item === "string" ? raw.item : "";
      const suggestions = item.length && item.length <= 128 ? this.library.search(item).matches.map(m => m.item) : [];
      const message = error.message.length > 2_000 ? `${error.message.slice(0, 2_000)}… (diagnostic shortened)` : error.message;
      return { result: { ok: false, error: { code: error.code, message, suggestions } },
        feedback: `Error ${error.code}: ${message}${suggestions.length ? `\nDocumented suggestions: ${suggestions.join(", ")}` : ""}` };
    }
  }
  private bounded(result: RecipeToolOutcome["result"], feedback: string): RecipeToolOutcome {
    if (feedback.length > RECIPE_LIMITS.maxResultChars || JSON.stringify(result).length > RECIPE_LIMITS.maxResultChars) {
      throw new RecipeIssue("RESULT_TOO_LARGE", "Recipe result exceeds the configured limit; no partial grid was returned.");
    }
    return { result, feedback };
  }
}
