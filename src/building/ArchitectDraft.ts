import { z } from "zod";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { parseArchitectDrawing } from "./ArchitectDrawing";
import type { Blueprint } from "./Blueprint";
import { BLUEPRINT_LIMITS as limits } from "./BuildingConfig";

export const StartBlueprintSchema = z.object({
  width: z.number().int().min(1).max(limits.maxWidth).describe("X: characters per row."),
  depth: z.number().int().min(1).max(limits.maxDepth).describe("Z: rows per horizontal layer."),
  height: z.number().int().min(1).max(limits.maxHeight).describe("Y: number of layers, bottom to top."),
  description: z.string().trim().min(1).max(500).describe("Short free-text plan describing the intended layers, interior and openings."),
}).strict();
export const SetBlueprintLayerSchema = z.object({
  layer: z.number().int().min(1).max(limits.maxHeight).describe("Layer number, starting at 1 for the bottom. You may replace any earlier layer."),
  drawing: z.string().min(1).max(2048).describe("One complete layer as a multiline string. Exactly depth rows of width characters. Replace every X with A (oak_planks) or . (air). No labels, comments, fences or blank rows."),
}).strict();
export const FinishBlueprintSchema = z.object({}).strict();

type Plan = z.infer<typeof StartBlueprintSchema>;

/** One delegation's mutable design, never a stored or physically built blueprint. */
export class ArchitectDraft {
  private plan?: Plan;
  private layers: (string[] | undefined)[] = [];

  reset(): void { this.plan = undefined; this.layers = []; }

  start(plan: Plan): TaskResult<{ message: string }> {
    if (this.plan && (this.plan.width !== plan.width || this.plan.depth !== plan.depth || this.plan.height !== plan.height)) {
      return invalid("Dimensions are locked for this draft. Existing layers were kept; start a new trial to change dimensions.");
    }
    const existing = !!this.plan;
    this.plan = { ...plan };
    if (!existing) this.layers = Array.from({ length: plan.height });
    return success({ message: existing ? "Description updated. Existing layers were kept." : "Draft started. Replace the X template one layer at a time." });
  }

  setLayer(layer: number, drawing: string): TaskResult<{ message: string }> {
    const plan = this.plan;
    if (!plan) return invalid("No draft yet. Call start_blueprint first.");
    if (layer > plan.height) return invalid(`Layer ${layer} does not exist. Use 1 to ${plan.height}.`);
    const rows = drawing.replace(/\r\n?/g, "\n").split("\n");
    const annotated: string[] = [];
    let hasErrors = rows.length !== plan.depth;
    for (let z = 0; z < Math.max(rows.length, plan.depth); z++) {
      const row = rows[z];
      const notes: string[] = [];
      if (row === undefined) notes.push(`Row ${z + 1}: missing row; expected ${plan.width} characters.`);
      else {
        if (z >= plan.depth) notes.push(`Row ${z + 1}: extra row; expected ${plan.depth} rows.`);
        const chars = [...row];
        if (chars.length !== plan.width) notes.push(`Row ${z + 1}: ${chars.length} characters; expected ${plan.width}.`);
        const bad = chars.flatMap((symbol, x) => symbol === "A" || symbol === "." ? [] : [x + 1]);
        if (bad.length) notes.push(`Row ${z + 1}, column(s) ${bad.slice(0, 8).join(", ")}: unsupported character; use only A or . (no X).`);
      }
      if (notes.length) hasErrors = true;
      // Diagnostics are bounded separately from the exact arguments retained in the trace.
      if (annotated.length < 16) annotated.push(`${row === undefined ? "<missing row>" : row.slice(0, 80)}${notes.length ? "  # " + notes.join(" ") : ""}`);
    }
    if (hasErrors) return invalid(`Layer ${layer} rejected. The current draft was not changed. Resubmit this entire layer without annotations.`, {
      annotatedDrawing: `Rejected attempt — layer ${layer}; expected ${plan.depth} rows of ${plan.width} characters:\n${annotated.join("\n")}${rows.length > 16 ? "\n# Further rows omitted from this diagnostic." : ""}`,
    });
    this.layers[layer - 1] = rows;
    return success({ message: `Layer ${layer} accepted. You can replace it later; this does not finish the blueprint.` });
  }

  finish(): TaskResult<Blueprint> {
    if (!this.plan) return invalid("No draft yet. Call start_blueprint first.");
    const missing = this.layers.flatMap((layer, i) => layer ? [] : [i + 1]);
    if (missing.length) return invalid(`Blueprint incomplete. Define layer(s) ${missing.join(", ")} before calling finish_blueprint.`, { missingLayers: missing });
    const result = parseArchitectDrawing(this.layers.map(layer => layer!.join("\n")).join("\n\n"));
    if (!result.ok) return invalid(result.error.message.replace("Correct the drawing and submit all layers again.", "Use set_blueprint_layer to correct layers, then finish_blueprint again."));
    return success({ ...result.value, description: this.plan.description });
  }

  /** Repeated in tool results so the latest protected exchange is a complete state snapshot. */
  render(): string {
    if (!this.plan) return "No draft yet. Call start_blueprint.";
    const { width, depth, height, description } = this.plan;
    const template = Array.from({ length: depth }, () => "X".repeat(width)).join("\n");
    return [
      `Current draft: width ${width} (X), depth ${depth} (Z), height ${height} (Y).`,
      `Plan: ${description}`,
      `Progress: ${this.layers.filter(Boolean).length}/${height} layers defined.`,
      "A = oak_planks; . = required air; X = not defined. Layers bottom to top; rows north to south; characters west to east.",
      ...this.layers.map((rows, i) => `Layer ${i + 1}${rows ? "" : " — not defined"}:\n${rows ? rows.join("\n") : template}`),
    ].join("\n\n");
  }
}

function invalid(message: string, facts: Record<string, unknown> = {}): TaskResult<never> {
  return failure("INVALID_ARGUMENT", message, { facts: { reason: "INVALID_BLUEPRINT", ...facts } });
}
