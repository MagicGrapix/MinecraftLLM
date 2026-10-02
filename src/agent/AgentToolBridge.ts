import type { z } from "zod";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { TaskSpec } from "../execution/Task";
import type { LLMToolCall } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { SkillLoader } from "../skills/SkillLoader";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import type { ActionFinishStatus } from "./ActionTypes";
import { ModelResponseError } from "./ModelResponseError";
import { fixedToolSchemas, ToolCatalogBuilder } from "./ToolCatalogBuilder";

export interface AgentToolResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly content: string;
}

export type ValidatedActionCall =
  | { readonly kind: "read" }
  | { readonly kind: "action"; readonly task: TaskSpec }
  | { readonly kind: "finish"; readonly status: ActionFinishStatus; readonly message: string };

interface AgentToolBridgeOptions {
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
    this.catalog = new ToolCatalogBuilder(options.capabilities, options.queries);
  }

  isReadTool(name: string): boolean {
    return this.options.queries.has(name) || readToolNames.has(name);
  }

  /** Validate the entire response before starting any observation or physical action. */
  validateResponseCalls(calls: readonly LLMToolCall[]): ValidatedActionCall {
    if (calls.length !== 1) {
      throw new ModelResponseError("Return exactly one available tool call. You may include a concise operational note with it. Use finish_step to return control.");
    }
    const call = calls[0]!;
    const raw = parseArguments(call.arguments);
    if (call.name === "finish_step") {
      const input = this.parseFixedArguments(call.name, raw);
      return { kind: "finish", status: input.status as ActionFinishStatus, message: input.message as string };
    }
    if (this.isReadTool(call.name)) {
      const schema = this.options.queries.get(call.name)?.inputSchema;
      if (schema) {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new ModelResponseError(invalidArgumentsMessage(call.name, parsed.error.issues));
      } else this.parseFixedArguments(call.name, raw);
      return { kind: "read" };
    }
    if (this.options.capabilities.has(call.name)) {
      const validation = this.options.capabilities.validateInput(call.name, raw);
      if (!validation.ok) throw new ModelResponseError(invalidArgumentsMessage(call.name, validation.issues));
      return { kind: "action", task: { capability: call.name, input: validation.input } };
    }
    throw new ModelResponseError('Unknown tool "' + call.name + '". Call a capability directly using its supplied input schema, a world query, or finish_step.');
  }

  async executeRead(call: LLMToolCall): Promise<AgentToolResult> {
    const startedAt = Date.now();
    let result: unknown;
    try {
      if (!this.isReadTool(call.name)) throw new ModelResponseError('Tool "' + call.name + '" is not a read/query tool.');
      result = await this.dispatchRead(call.name, parseArguments(call.arguments));
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
    if (!parsed.success) throw new ModelResponseError(invalidArgumentsMessage(name, parsed.error.issues));
    return parsed.data as Record<string, unknown>;
  }

  private async dispatchRead(name: string, rawArguments: unknown): Promise<unknown> {
    if (this.options.queries.has(name)) {
      const result = await this.options.queries.execute(name, rawArguments);
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

function parseArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new ModelResponseError("Tool arguments are not valid JSON."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelResponseError("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function invalidArgumentsMessage(name: string, issues: readonly { path: (string | number)[]; message: string }[]): string {
  return 'Invalid arguments for "' + name + '": ' + issues.map((issue) => (issue.path.join(".") || "input") + ": " + issue.message).join("; ");
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
