import { ingredientCounts, patternRows, type RecipeFile } from "./RecipeSchema";

export function renderRecipe(file: RecipeFile, index: number): string {
  const recipe = file.variants[index - 1]!;
  const size = recipe.station === "inventory" ? 2 : 3;
  const counts = ingredientCounts(recipe);
  const lines = [`${file.item} x${recipe.outputCount} per craft`, `Variant ${index}/${file.variants.length}: ${recipe.label}`,
    `Grid: ${size}x${size} | Station: ${recipe.station}`, ""];
  if (recipe.type === "shaped") {
    const rows = patternRows(recipe.rows);
    for (const [symbol, item] of Object.entries(recipe.palette)) lines.push(`${symbol} = ${item} x${counts[item]}`);
    lines.push("");
    for (let z = 0; z < size; z++) lines.push(Array.from({ length: size }, (_, x) => {
      const cell = rows[z]?.[x];
      return `[${!cell || cell === "." ? " " : cell}]`;
    }).join(" "));
  } else {
    lines.push("Placement: any order", ...Object.entries(counts).map(([item, count]) => `${item} x${count}`));
  }
  const others = file.variants.flatMap((v, i) => i === index - 1 ? [] : [`${i + 1}: ${v.label} (x${v.outputCount}, ${v.station})`]);
  if (others.length) lines.push("", `Other variants: ${others.join("; ")}`);
  lines.push("", "Catalog knowledge only; not a check of current ingredients or station access.");
  return lines.join("\n");
}
