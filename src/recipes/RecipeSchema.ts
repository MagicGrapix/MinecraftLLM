import { z } from "zod";
import { RECIPE_LIMITS } from "../config";

export const ItemNameSchema = z.string().regex(/^[a-z0-9_]{1,80}$/, "Use an exact Minecraft item name, not a path.");
const base = {
  label: z.string().trim().min(1).max(80),
  outputCount: z.number().int().min(1).max(64),
  station: z.enum(["inventory", "crafting_table"]),
};
export const RecipeVariantSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("shaped"),
    palette: z.record(z.string().regex(/^[A-Z]$/), ItemNameSchema),
    rows: z.array(z.string().regex(/^[A-Z.]{1,3}$/)).min(1).max(3),
  }).strict(),
  z.object({ ...base, type: z.literal("shapeless"),
    ingredients: z.array(z.object({ item: ItemNameSchema, count: z.number().int().min(1).max(9) }).strict()).min(1).max(9),
  }).strict(),
]);
export const RecipeFileSchema = z.object({
  item: ItemNameSchema,
  minecraftVersion: z.string().min(1).max(32),
  variants: z.array(RecipeVariantSchema).min(1).max(RECIPE_LIMITS.maxVariants),
}).strict();
export type RecipeFile = z.infer<typeof RecipeFileSchema>;
export type RecipeVariant = z.infer<typeof RecipeVariantSchema>;

/** Remove translation-only padding before presenting the minimum grid. */
export function patternRows(rows: readonly string[]): string[] {
  const occupied = rows.flatMap((row, z) => [...row].flatMap((c, x) => c === "." ? [] : [{ x, z }]));
  if (!occupied.length) return [];
  const left = Math.min(...occupied.map(p => p.x)), right = Math.max(...occupied.map(p => p.x));
  return rows.slice(Math.min(...occupied.map(p => p.z)), Math.max(...occupied.map(p => p.z)) + 1)
    .map(row => row.slice(left, right + 1));
}

export function ingredientCounts(recipe: RecipeVariant): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  if (recipe.type === "shapeless") {
    for (const { item, count } of recipe.ingredients) counts[item] = (counts[item] ?? 0) + count;
  } else {
    for (const cell of recipe.rows.join("")) {
      if (cell !== ".") {
        const item = recipe.palette[cell]!;
        counts[item] = (counts[item] ?? 0) + 1;
      }
    }
  }
  return counts;
}
