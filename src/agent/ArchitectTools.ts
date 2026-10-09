import type { Blueprint, MaterialRequirement } from "../building/Blueprint";
import { SubmitDrawingSchema, parseArchitectDrawing } from "../building/ArchitectDrawing";
import type { BlueprintStore } from "../building/BlueprintStore";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { LLMTool, LLMToolCall } from "../llm/LLMClient";
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
  /** Optional readable native-tool message; structured result stays in logs/inspector. */
  readonly feedback?: string;
  readonly accepted?: ArchitectReport;
  readonly fatal?: boolean;
}

export interface ArchitectToolset {
  readonly definitions: readonly LLMTool[];
  execute(call: LLMToolCall, signal: AbortSignal): Promise<ArchitectToolOutcome>;
  reset?(): void;
}

/** Offline-only tool surface. Deliberately has no runtime, Executor or controller. */
export class ArchitectTools implements ArchitectToolset {
  readonly definitions: readonly LLMTool[] = [
    {
      name: "submit_blueprint",
      description: "Does: Validate and save the complete text drawing.\nSuccess: Returns a blueprint reference, inferred dimensions and block count; ends this delegation.\nLimits: Does not build or prove that the drawing meets the request.\nNotes: On error, correct the indicated layer or row and resubmit the entire drawing.",
      parameters: toJsonSchema(SubmitDrawingSchema),
    },
  ];

  constructor(private readonly store: Pick<BlueprintStore, "save">) {}

  async execute(call: LLMToolCall, signal: AbortSignal): Promise<ArchitectToolOutcome> {
    signal.throwIfAborted();
    if (!this.definitions.some(tool => tool.name === call.name)) {
      return { result: failure("INVALID_ARGUMENT", "Unknown Architect tool. Use submit_blueprint with one drawing string.", {
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
    const parsed = SubmitDrawingSchema.safeParse(args);
    if (!parsed.success) return { result: failure("INVALID_ARGUMENT", invalidToolArguments(call.name, args, parsed.error.issues, SubmitDrawingSchema), {
      facts: { reason: "INVALID_TOOL_ARGUMENTS", issues: parsed.error.issues.slice(0, 5).map(issue => ({ path: issue.path.join("."), message: issue.message })) },
    }) };
    const drawing = parseArchitectDrawing(parsed.data.drawing);
    if (!drawing.ok) return { result: drawing };

    return saveArchitectBlueprint(this.store, drawing.value);
  }
}

/** Both design modes share the same validated, immutable publication and handoff. */
export async function saveArchitectBlueprint(store: Pick<BlueprintStore, "save">, drawing: Blueprint): Promise<ArchitectToolOutcome> {
  // Store validates before publishing. Await publication even if stop arrives during filesystem I/O.
  const saved = await store.save(drawing);
  if (!saved.ok) return { result: saved, fatal: saved.error.facts?.reason !== "INVALID_BLUEPRINT" };
  const { blueprint, id, formatVersion, minecraftVersion, materials } = saved.value;
  const accepted: ArchitectReport = {
    blueprintId: id, formatVersion, minecraftVersion, name: blueprint.name, description: blueprint.description,
    dimensions: { width: blueprint.width, depth: blueprint.depth, height: blueprint.layers.length },
    materials: structuredClone(materials),
  };
  return { result: success(accepted), accepted };
}
