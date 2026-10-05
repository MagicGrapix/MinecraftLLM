import { BlueprintSchema, type MaterialRequirement } from "../building/Blueprint";
import type { BlueprintStore } from "../building/BlueprintStore";
import { SUPPORTED_DOORS } from "../building/BlueprintDoors";
import { BLUEPRINT_SOLID_BLOCKS } from "../building/BuildingConfig";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { LLMTool, LLMToolCall } from "../llm/LLMClient";
import type { MaterialCatalog } from "../world/MaterialCatalog";
import { LookupMaterialSchema, LOOKUP_MATERIAL_DESCRIPTION, lookupMaterial, blueprintSupport } from "../world/queries/LookupMaterial";
import { invalidToolArguments, parseToolArguments } from "../shared/ToolArgumentFeedback";
import { toJsonSchema } from "./ToolCatalogBuilder";

/** Handoff contains only validated metadata, never the grid or private transcript. */
export interface ArchitectReport {
  readonly blueprintId: string;
  readonly formatVersion: number;
  readonly minecraftVersion: string;
  readonly name: string;
  readonly description: string;
  readonly dimensions: { readonly width: number; readonly depth: number; readonly height: number };
  readonly materials: readonly MaterialRequirement[];
}

export interface ArchitectToolOutcome {
  readonly result: TaskResult<unknown>;
  readonly accepted?: ArchitectReport;
  readonly fatal?: boolean;
}

/** Offline-only tool surface. Deliberately has no runtime, Executor or controller. */
export class ArchitectTools {
  readonly definitions: readonly LLMTool[] = [
    {
      name: "lookup_material",
      description: LOOKUP_MATERIAL_DESCRIPTION,
      parameters: toJsonSchema(LookupMaterialSchema),
    },
    {
      name: "submit_blueprint",
      description: "Does: Validate and save the complete blueprint passed directly as arguments.\nSuccess: Returns an immutable blueprintId, dimensions and calculated material bill; ends this delegation automatically.\nLimits: Does not build, obtain materials, verify terrain access or prove the design meets the player's intent.\nNotes: On validation errors, fix the indicated paths and resubmit the full drawing. Never put doors in the palette; declare them in dependencies.doors.",
      parameters: toJsonSchema(BlueprintSchema),
    },
  ];

  constructor(readonly catalog: MaterialCatalog, private readonly store: Pick<BlueprintStore, "save">) {}

  supportedMaterials(): { cubes: string[]; doors: string[] } {
    return {
      cubes: BLUEPRINT_SOLID_BLOCKS.filter(name => blueprintSupport(this.catalog, name) === "palette_cube"),
      doors: SUPPORTED_DOORS.filter(name => blueprintSupport(this.catalog, name) === "door_dependency"),
    };
  }

  async execute(call: LLMToolCall, signal: AbortSignal): Promise<ArchitectToolOutcome> {
    signal.throwIfAborted();
    if (!this.definitions.some(tool => tool.name === call.name)) {
      return { result: failure("INVALID_ARGUMENT", "Unknown Architect tool. Use lookup_material or submit_blueprint.", {
        facts: { reason: "UNKNOWN_TOOL", tool: call.name.slice(0, 128) },
      }) };
    }
    let args: unknown;
    try { args = parseToolArguments(call.name, call.arguments); }
    catch (error: unknown) {
      return { result: failure("INVALID_ARGUMENT", error instanceof Error ? error.message : "Expected a JSON object.", {
        facts: { reason: "INVALID_TOOL_ARGUMENTS", tool: call.name },
      }) };
    }
    if (call.name === "lookup_material") {
      const parsed = LookupMaterialSchema.safeParse(args);
      if (!parsed.success) return { result: failure("INVALID_ARGUMENT", invalidToolArguments(call.name, args, parsed.error.issues, LookupMaterialSchema), {
        facts: { issues: parsed.error.issues.slice(0, 5).map(issue => ({ path: issue.path.join("."), message: issue.message })) },
      }) };
      return { result: success(lookupMaterial(this.catalog, parsed.data)) };
    }

    // Store validates before publishing. Await publication even if stop arrives during filesystem I/O.
    const saved = await this.store.save(args);
    if (!saved.ok) return { result: saved, fatal: saved.error.facts?.reason !== "INVALID_BLUEPRINT" };
    const { blueprint, id, formatVersion, minecraftVersion, materials } = saved.value;
    const accepted: ArchitectReport = {
      blueprintId: id, formatVersion, minecraftVersion, name: blueprint.name, description: blueprint.description,
      dimensions: { width: blueprint.width, depth: blueprint.depth, height: blueprint.layers.length },
      materials: structuredClone(materials),
    };
    return { result: success(accepted), accepted };
  }
}
