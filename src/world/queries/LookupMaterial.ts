import { z } from "zod";
import { SUPPORTED_DOORS } from "../../building/BlueprintDoors";
import { BLUEPRINT_SOLID_BLOCKS } from "../../building/BuildingConfig";
import type { MaterialCatalog, MaterialMatch } from "../MaterialCatalog";
import { querySuccess } from "./QueryResult";
import type { WorldQuery } from "./WorldQuery";

export const LookupMaterialSchema = z.object({
  query: z.string().trim().min(1).max(128).describe("Exact Minecraft name or partial/spelled name, e.g. oak_planks or oak_plate."),
  kind: z.enum(["block", "item"]).default("block"),
}).strict();

export const LOOKUP_MATERIAL_DESCRIPTION = "Does: Find exact Minecraft block/item names and up to five alternatives.\nSuccess: Reports names known by this registry and blueprint support.\nLimits: Does not prove inventory, recipes or world availability.\nNotes: Exact names are required; suggestions never auto-correct a blueprint. kind defaults to block.";

export function blueprintSupport(catalog: MaterialCatalog, name: string): "palette_cube" | "door_dependency" | "unsupported" {
  if (!catalog.resolve("block", name) || !catalog.resolve("item", name)) return "unsupported";
  if (SUPPORTED_DOORS.includes(name)) return "door_dependency";
  return BLUEPRINT_SOLID_BLOCKS.includes(name) && catalog.isFullBlock(name) ? "palette_cube" : "unsupported";
}

export function lookupMaterial(catalog: MaterialCatalog, input: z.input<typeof LookupMaterialSchema>) {
  const found = catalog.search(input.query, input.kind);
  const describe = (match: MaterialMatch) => ({ ...match, blueprintSupport: blueprintSupport(catalog, match.name) });
  return { ...found, exact: found.exact ? describe(found.exact) : null, suggestions: found.suggestions.map(describe) };
}

export function createLookupMaterialQuery(catalog: MaterialCatalog): WorldQuery<z.input<typeof LookupMaterialSchema>, ReturnType<typeof lookupMaterial>> {
  return {
    name: "lookup_material", description: LOOKUP_MATERIAL_DESCRIPTION, inputSchema: LookupMaterialSchema,
    async execute(input) { return querySuccess(lookupMaterial(catalog, input)); },
  };
}
