import type { RecipeFile } from "./RecipeSchema";
import { ingredientCounts } from "./RecipeSchema";

export interface RecipeReference { readonly item: string; readonly variant: number }
export interface PlanRecipe extends RecipeReference {
  readonly minecraftVersion: string;
  readonly recipe: RecipeFile["variants"][number];
}
export const recipeKey = (ref: RecipeReference): string => `${ref.item}#${ref.variant}`;

export function formatPlanRecipes(recipes: readonly PlanRecipe[]): string {
  if (!recipes.length) return "";
  return ["Recipes — quantities per craft (not the task target):", ...recipes.map(({ item, variant, recipe }) =>
    `${item} (variant ${variant}): ${Object.entries(ingredientCounts(recipe)).map(([name, count]) => `${count} ${name}`).join(" + ")} -> ${recipe.outputCount} ${item}; ${recipe.station === "inventory" ? "inventory 2x2" : "crafting table 3x3"}.`),
    "Documented variants, not enforced crafting inputs. Preserve resources needed by later steps.",
  ].join("\n");
}
