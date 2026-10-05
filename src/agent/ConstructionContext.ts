import type { ArchitectReport } from "./ArchitectTools";

/** Request-owned reference. Never contains the drawing or a subagent transcript. */
export interface ConstructionContext {
  readonly blueprint: ArchitectReport;
  readonly instruction: string;
}

export function formatConstructionContext(construction?: ConstructionContext | null): string {
  if (!construction) return "No blueprint selected for this request. Earlier references are not active.";
  const { blueprint: b, instruction } = construction;
  return [
    `Selected blueprint: ${b.blueprintId}`,
    `Design: ${b.name} — ${b.description}`,
    `Size: ${b.dimensions.width} x ${b.dimensions.depth} x ${b.dimensions.height} (width x depth x height).`,
    `Design instruction: ${instruction}`,
    `Finished-item bill for a fresh build: ${b.materials.map(m => `${m.item} x${m.quantity}`).join(", ")}.`,
    "Validated drawing, not a completed building or proof of player intent. Materials are not reserved; check current inventory. No build origin selected here.",
  ].join("\n");
}
