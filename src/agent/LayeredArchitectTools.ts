import { z } from "zod";
import { ArchitectDraft, StartBlueprintSchema, SetBlueprintLayerSchema, FinishBlueprintSchema } from "../building/ArchitectDraft";
import type { BlueprintStore } from "../building/BlueprintStore";
import { failure } from "../execution/TaskResult";
import type { LLMTool, LLMToolCall } from "../llm/LLMClient";
import { invalidToolArguments, parseToolArguments } from "../shared/ToolArgumentFeedback";
import { saveArchitectBlueprint, type ArchitectToolOutcome, type ArchitectToolset } from "./ArchitectTools";
import { toJsonSchema } from "./ToolCatalogBuilder";

const schemas = { start_blueprint: StartBlueprintSchema, set_blueprint_layer: SetBlueprintLayerSchema, finish_blueprint: FinishBlueprintSchema };

/** Offline experiment: stateful draft tools, the same final store contract as the complete-drawing mode. */
export class LayeredArchitectTools implements ArchitectToolset {
  private readonly draft = new ArchitectDraft();
  readonly definitions: readonly LLMTool[] = [
    { name: "start_blueprint", parameters: toJsonSchema(StartBlueprintSchema),
      description: "Does: Start a draft with exterior dimensions and a short free-text layer plan.\nSuccess: Returns X templates and the current draft.\nNotes: Call first. Calling again with the same dimensions updates the description without losing layers; dimensions cannot change during a draft." },
    { name: "set_blueprint_layer", parameters: toJsonSchema(SetBlueprintLayerSchema),
      description: "Does: Define or replace one complete layer, numbered from 1 at the bottom. You can edit earlier layers.\nSuccess: Returns the full updated draft; does not finish it.\nErrors: Annotates the rejected attempt and keeps the previous draft.\nNotes: Replace every X with A or .; submit only the layer's rows, without annotations." },
    { name: "finish_blueprint", parameters: toJsonSchema(FinishBlueprintSchema),
      description: "Does: Validate and save the whole current draft. Call after reviewing all layers.\nSuccess: Returns the saved reference and material count; ends this delegation.\nLimits: Checks format and supported materials, not habitability or compliance with the request. Does not build.\nErrors: Correct layers with set_blueprint_layer, then try again." },
  ];

  constructor(private readonly store: Pick<BlueprintStore, "save">) {}
  reset(): void { this.draft.reset(); }

  async execute(call: LLMToolCall, signal: AbortSignal): Promise<ArchitectToolOutcome> {
    signal.throwIfAborted();
    const outcome = await this.dispatch(call);
    // Even schema/unknown-tool errors retain the canonical draft in the latest native exchange.
    const draft = this.draft.render();
    const feedback = outcome.result.ok
      ? `${outcome.accepted ? "Blueprint validated and saved." : (outcome.result.value as { message: string }).message}\n\n${draft}`
      : [`Error: ${outcome.result.error.code}. ${outcome.result.error.message}`,
        outcome.result.error.facts?.annotatedDrawing,
        outcome.result.error.facts?.issues ? JSON.stringify(outcome.result.error.facts.issues) : undefined,
        draft].filter(Boolean).join("\n\n");
    return { ...outcome, feedback, result: outcome.result.ok
      ? { ok: true, value: { ...outcome.result.value as object, draft } }
      : { ok: false, error: { ...outcome.result.error, facts: { ...outcome.result.error.facts, draft } } } };
  }

  private async dispatch(call: LLMToolCall): Promise<ArchitectToolOutcome> {
    if (!Object.hasOwn(schemas, call.name)) return { result: failure("INVALID_ARGUMENT", "Unknown Architect tool. Use start_blueprint, set_blueprint_layer or finish_blueprint.", {
      facts: { reason: "UNKNOWN_TOOL", tool: call.name.slice(0, 128) },
    }) };
    const schema: z.ZodTypeAny = schemas[call.name as keyof typeof schemas];
    let args: unknown;
    try { args = parseToolArguments(call.name, call.arguments); }
    catch (error: unknown) { return { result: failure("INVALID_ARGUMENT", error instanceof Error ? error.message : "Expected a JSON object.", {
      facts: { reason: "INVALID_TOOL_ARGUMENTS", tool: call.name },
    }) }; }
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { result: failure("INVALID_ARGUMENT", invalidToolArguments(call.name, args, parsed.error.issues, schema), {
      facts: { reason: "INVALID_TOOL_ARGUMENTS" },
    }) };
    if (call.name === "start_blueprint") return { result: this.draft.start(parsed.data as z.infer<typeof StartBlueprintSchema>) };
    if (call.name === "set_blueprint_layer") {
      const { layer, drawing } = parsed.data as z.infer<typeof SetBlueprintLayerSchema>;
      return { result: this.draft.setLayer(layer, drawing) };
    }
    const blueprint = this.draft.finish();
    return blueprint.ok ? saveArchitectBlueprint(this.store, blueprint.value) : { result: blueprint };
  }
}
