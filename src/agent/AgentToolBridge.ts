import type { z } from "zod";
import type { RecipeTools } from "../recipes/RecipeTools";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { TaskSpec } from "../execution/Task";
import type { LLMToolCall } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { SkillLoader } from "../skills/SkillLoader";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import type { ActionFinishStatus } from "./ActionTypes";
import { ModelResponseError } from "./ModelResponseError";
import { invalidToolArguments, parseToolArguments } from "../shared/ToolArgumentFeedback";
import { fixedToolSchemas, ToolCatalogBuilder } from "./ToolCatalogBuilder";

export interface AgentToolResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly content: string;
  readonly feedback?: string;
}

export type ValidatedActionCall =
  | { readonly kind: "read" }
  | { readonly kind: "action"; readonly task: TaskSpec }
  | { readonly kind: "finish"; readonly status: ActionFinishStatus; readonly message: string };

interface AgentToolBridgeOptions {
  readonly recipes?: RecipeTools;
  readonly capabilities: CapabilityRegistry;
  readonly queries: WorldQueryRegistry;
  readonly skills: SkillRegistry;
  readonly skillLoader: SkillLoader;
  readonly landmarks: LandmarkMemory;
  readonly currentDimension?: () => string;
  readonly isPositionLoaded?: (position: { x: number; y: number; z: number }) => boolean;
  readonly maxResultChars?: number;
}

const readToolNames = new Set(["list_skills", "load_skill", "list_landmarks"]);

export class AgentToolBridge {
  readonly catalog: ToolCatalogBuilder;
  private readonly maxResultChars: number;

  constructor(private readonly options: AgentToolBridgeOptions) {
    this.maxResultChars = options.maxResultChars ?? 12_000;
    this.catalog = new ToolCatalogBuilder(options.capabilities, options.queries, options.recipes?.definitions);
  }

  isReadTool(name: string): boolean {
    return this.options.queries.has(name) || readToolNames.has(name) || !!this.options.recipes?.schema(name);
  }

  /** Validate the entire response before starting any observation or physical action. */
  validateResponseCalls(calls: readonly LLMToolCall[]): ValidatedActionCall {
    if (calls.length !== 1) {
      throw new ModelResponseError("Return exactly one available tool call. You may include a concise operational note with it. Use finish_step to return control.");
    }
    const call = calls[0]!;
    const raw = parseArguments(call.name, call.arguments);
    if (call.name === "finish_step") {
      const input = this.parseFixedArguments(call.name, raw);
      return { kind: "finish", status: input.status as ActionFinishStatus, message: input.message as string };
    }
    if (this.isReadTool(call.name)) {
      const schema = this.options.queries.get(call.name)?.inputSchema ?? this.options.recipes?.schema(call.name);
      if (schema) {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new ModelResponseError(invalidToolArguments(call.name, raw, parsed.error.issues, schema));
      } else this.parseFixedArguments(call.name, raw);
      return { kind: "read" };
    }
    if (this.options.capabilities.has(call.name)) {
      const validation = this.options.capabilities.validateInput(call.name, raw);
      if (!validation.ok) throw new ModelResponseError(invalidToolArguments(call.name, raw, validation.issues, this.options.capabilities.get(call.name)!.inputSchema));
      const timeoutMs = this.options.capabilities.get(call.name)!.defaultTimeoutMs;
      return { kind: "action", task: { capability: call.name, input: validation.input, ...(timeoutMs === undefined ? {} : { timeoutMs }) } };
    }
    throw new ModelResponseError('Unknown tool "' + call.name + '". Call a capability directly using its supplied input schema, a world query, or finish_step.');
  }

  async executeRead(call: LLMToolCall, signal?: AbortSignal): Promise<AgentToolResult> {
    if (this.options.recipes?.schema(call.name)) {
      signal?.throwIfAborted();
      const outcome = this.options.recipes.execute(call.name, parseArguments(call.name, call.arguments));
      return { toolCallId: call.id, name: call.name, ok: outcome.result.ok,
        content: JSON.stringify(outcome.result), feedback: outcome.feedback };
    }
    const startedAt = Date.now();
    let result: unknown;
    try {
      if (!this.isReadTool(call.name)) throw new ModelResponseError('Tool "' + call.name + '" is not a read/query tool.');
      signal?.throwIfAborted();
      result = await this.dispatchRead(call.name, parseArguments(call.name, call.arguments), signal);
    } catch (error: unknown) {
      if (error instanceof ModelResponseError) throw error;
      result = failure("TOOL_ERROR", error instanceof Error ? error.message : String(error));
    }
    const content = compactJson(result, this.maxResultChars);
    const ok = isSuccessfulResult(JSON.parse(content));
    console.info("Agent read tool completed.", { toolName: call.name, ok, durationMs: Date.now() - startedAt });
    return { toolCallId: call.id, name: call.name, ok, content };
  }

  private parseFixedArguments(name: string, raw: unknown): Record<string, unknown> {
    const schema = Object.hasOwn(fixedToolSchemas, name)
      ? fixedToolSchemas[name as keyof typeof fixedToolSchemas] as z.ZodTypeAny : undefined;
    if (!schema) throw new ModelResponseError('Unknown tool "' + name + '".');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelResponseError(invalidToolArguments(name, raw, parsed.error.issues, schema));
    return parsed.data as Record<string, unknown>;
  }

  private async dispatchRead(name: string, rawArguments: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.options.queries.has(name)) {
      const result = await this.options.queries.execute(name, rawArguments, signal);
      if (name === "get_block" && result.ok && typeof rawArguments === "object" && rawArguments !== null && "position" in rawArguments) {
        const position = (rawArguments as { position: { x: number; y: number; z: number } }).position;
        const dimension = this.options.currentDimension?.();
        if (dimension) {
          const blockName = typeof result.value === "object" && result.value !== null && "name" in result.value && typeof result.value.name === "string"
            ? result.value.name : null;
          await this.options.landmarks.verifyBlock(dimension, position, blockName, this.options.isPositionLoaded?.(position) ?? false);
        }
      }
      return result;
    }
    const input = this.parseFixedArguments(name, rawArguments);
    switch (name) {
      case "list_skills": return success(this.options.skills.list());
      case "load_skill": return success(await this.options.skillLoader.load(input.name as string));
      case "list_landmarks": return success(this.options.landmarks.list());
      default: return failure("TOOL_NOT_FOUND", 'Unknown tool "' + name + '".');
    }
  }
}

function parseArguments(name: string, raw: string): Record<string, unknown> {
  try { return parseToolArguments(name, raw); }
  catch (error) { throw new ModelResponseError((error as Error).message); }
}

function success(value: unknown) { return { ok: true, value }; }
function failure(code: string, message: string) { return { ok: false, error: { code, message } }; }
function isSuccessfulResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}
function compactJson(value: unknown, maxChars: number): string {
  const json = JSON.stringify(value);
  return json.length <= maxChars ? json : JSON.stringify(failure("RESULT_TOO_LARGE", "Tool result exceeded " + maxChars + " characters."));
}
