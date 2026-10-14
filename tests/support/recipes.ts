import { resolve } from "node:path";
import MinecraftData from "minecraft-data";
import { RecipeLibrary } from "../../src/recipes/RecipeLibrary";
import { RecipeTools } from "../../src/recipes/RecipeTools";

export async function loadRecipeTools(): Promise<RecipeTools> {
  return new RecipeTools(await RecipeLibrary.load(resolve("recipes"), MinecraftData("1.21.11")));
}
