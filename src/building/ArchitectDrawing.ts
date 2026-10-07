import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { Blueprint } from "./Blueprint";
import { BLUEPRINT_LIMITS } from "./BuildingConfig";

export const ARCHITECT_BLOCK = "oak_planks";

export const SubmitDrawingSchema = z.object({
  drawing: z.string().min(1).max(2048).describe(
    "Complete drawing as one multiline string. A = oak_planks, . = required air. " +
    "One row per line; a blank line separates layers, bottom to top. " +
    "No headings, code fences or arrays. A single 3x3 floor is AAA\nAAA\nAAA.",
  ),
}).strict();

/** Adapt the small model-facing format to the existing stored/builder contract. No silent repairs. */
export function parseArchitectDrawing(drawing: string): TaskResult<Blueprint> {
  if (!drawing.length || drawing.length > 2048) return invalid("Drawing must contain 1 to 2048 characters.");
  const layers: string[][] = [];
  let rows: string[] = [];
  for (const line of drawing.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^[ \t]*$/.test(line)) {
      if (rows.length) { layers.push(rows); rows = []; }
    } else rows.push(line);
  }
  if (rows.length) layers.push(rows);
  if (!layers.length) return invalid("Drawing is empty.");
  const width = layers[0]![0]!.length;
  const depth = layers[0]!.length;
  if (layers.length > BLUEPRINT_LIMITS.maxHeight) return invalid(`Drawing has ${layers.length} layers; maximum is ${BLUEPRINT_LIMITS.maxHeight}.`);
  if (width > BLUEPRINT_LIMITS.maxWidth) return invalid(`Layer 1, row 1 has ${width} characters; maximum is ${BLUEPRINT_LIMITS.maxWidth}.`, 1, 1);
  if (depth > BLUEPRINT_LIMITS.maxDepth) return invalid(`Layer 1 has ${depth} rows; maximum is ${BLUEPRINT_LIMITS.maxDepth}.`, 1);
  let cubes = 0;
  for (const [y, layer] of layers.entries()) {
    if (layer.length !== depth) return invalid(`Layer ${y + 1} has ${layer.length} rows; expected ${depth}, like layer 1.`, y + 1);
    for (const [z, row] of layer.entries()) {
      if (!/^[A.]+$/.test(row)) return invalid(`Layer ${y + 1}, row ${z + 1} contains unsupported characters. Use only A (oak_planks) and . (required air), without spaces or labels.`, y + 1, z + 1);
      if (row.length !== width) return invalid(`Layer ${y + 1}, row ${z + 1} has ${row.length} characters; expected ${width}, like layer 1, row 1.`, y + 1, z + 1);
      cubes += [...row].filter(symbol => symbol === "A").length;
    }
  }
  if (!cubes) return invalid("Drawing must contain at least one A (oak_planks).");
  return success({
    name: `oak_structure_${width}x${depth}x${layers.length}`,
    description: "Oak structure designed by the Architect.",
    width, depth, palette: { A: ARCHITECT_BLOCK }, layers, dependencies: { doors: [] },
  });
}

function invalid(message: string, layer?: number, row?: number): TaskResult<Blueprint> {
  return failure("INVALID_ARGUMENT", `${message} Correct the drawing and submit all layers again.`, {
    facts: { reason: "INVALID_BLUEPRINT", issues: [{ path: "drawing", message,
      ...(layer === undefined ? {} : { layer }), ...(row === undefined ? {} : { row }) }] },
  });
}
