import type { z } from "zod";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { TaskSpec } from "../execution/Task";
import type { LLMToolCall } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { SkillLoader } from "../skills/SkillLoader";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import type { AgentDecision } from "./AgentDecision";
import { ModelResponseError } from "./ModelResponseError";
import {
  decisionToolNames,
  fixedToolSchemas,
  toJsonSchema,
  ToolCatalogBuilder,
} from "./ToolCatalogBuilder";

export type AgentPermissionMode = "readonly" | "action";

export interface AgentToolResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly content: string;
}

interface AgentToolBridgeOptions {
  readonly capabilities: CapabilityRegistry;
  readonly queries: WorldQueryRegistry;
  readonly skills: SkillRegistry;
  readonly skillLoader: SkillLoader;
  readonly landmarks: LandmarkMemory;
  readonly currentDimension?: () => string;
  readonly isPositionLoaded?: (
    position: { x: number; y: number; z: number },
  ) => boolean;
  readonly maxResultChars?: number;
}

const readToolNames = new Set([
  "list_skills",
  "load_skill",
  "get_capability_schemas",
  "list_landmarks",
]);

export class AgentToolBridge {
  readonly catalog: ToolCatalogBuilder;
  private readonly maxResultChars: number;

  constructor(private readonly options: AgentToolBridgeOptions) {
    this.maxResultChars = options.maxResultChars ?? 12_000;
    this.catalog = new ToolCatalogBuilder(
      options.capabilities,
      options.queries,
      options.skills,
    );
  }

  isDecision(name: string): boolean {
    return decisionToolNames.has(name);
  }

  isReadTool(name: string): boolean {
    return this.options.queries.has(name) || readToolNames.has(name);
  }

  parseDecision(call: LLMToolCall): AgentDecision {
    if (!this.isDecision(call.name)) {
      throw new ModelResponseError(
        `"${call.name}" is not a terminal agent decision.`,
      );
    }
    const input = this.parseFixedArguments(call);
    switch (call.name) {
      case "set_plan": {
        const tasks = this.validateTasks(input.tasks);
        return { type: "set_plan", tasks };
      }
      case "continue_plan":
        return { type: "continue_plan" };
      case "finish_run":
        return {
          type: "finish_run",
          status: input.status as "success" | "failure" | "needs_user",
          message: input.message as string,
        };
      default:
        throw new ModelResponseError(
          `Unsupported decision "${call.name}".`,
        );
    }
  }

  async executeRead(call: LLMToolCall): Promise<AgentToolResult> {
    const startedAt = Date.now();
    let result: unknown;
    let ok = false;
    try {
      if (!this.isReadTool(call.name)) {
        throw new ModelResponseError(
          `Tool "${call.name}" is not a read/query tool.`,
        );
      }
      const rawArguments = parseArguments(call.arguments);
      result = await this.dispatchRead(call.name, rawArguments);
      ok = isSuccessfulResult(result);
    } catch (error: unknown) {
      if (error instanceof ModelResponseError) throw error;
      result = failure(
        "TOOL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
    console.info("Agent read tool completed.", {
      toolName: call.name,
      ok,
      durationMs: Date.now() - startedAt,
    });
    return {
      toolCallId: call.id,
      name: call.name,
      ok,
      content: compactJson(result, this.maxResultChars),
    };
  }

  validateResponseCalls(
    calls: readonly LLMToolCall[],
    mode: AgentPermissionMode,
  ):
    | { readonly kind: "reads"; readonly calls: readonly LLMToolCall[] }
    | { readonly kind: "decision"; readonly decision: AgentDecision } {
    if (calls.length === 0) {
      throw new ModelResponseError(
        mode === "action"
          ? "Action reflection must return one decision tool call."
          : "Readonly reflection must return JSON content.",
      );
    }
    const decisions = calls.filter((call) => this.isDecision(call.name));
    if (decisions.length > 0) {
      if (mode !== "action") {
        throw new ModelResponseError(
          "Readonly reflection cannot return an action decision.",
        );
      }
      if (calls.length !== 1 || decisions.length !== 1) {
        throw new ModelResponseError(
          "A decision must be the only tool call in its response.",
        );
      }
      return {
        kind: "decision",
        decision: this.parseDecision(decisions[0]!),
      };
    }
    for (const call of calls) {
      if (!this.isReadTool(call.name)) {
        throw new ModelResponseError(`Unknown tool "${call.name}".`);
      }
      this.validateReadArguments(call);
    }
    return { kind: "reads", calls };
  }

  private validateReadArguments(call: LLMToolCall): void {
    const raw = parseArguments(call.arguments);
    if (this.options.queries.has(call.name)) {
      const query = this.options.queries.get(call.name);
      if (!query) throw new ModelResponseError(`Unknown query "${call.name}".`);
      const parsed = query.inputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ModelResponseError(
          invalidArgumentsMessage(call.name, parsed.error.issues),
        );
      }
      return;
    }
    this.parseFixedArguments(call);
  }

  private parseFixedArguments(
    call: LLMToolCall,
  ): Record<string, unknown> {
    const schema = fixedToolSchemas[
      call.name as keyof typeof fixedToolSchemas
    ] as z.ZodTypeAny | undefined;
    if (!schema) {
      throw new ModelResponseError(`Unknown tool "${call.name}".`);
    }
    const parsed = schema.safeParse(parseArguments(call.arguments));
    if (!parsed.success) {
      throw new ModelResponseError(
        invalidArgumentsMessage(call.name, parsed.error.issues),
      );
    }
    return parsed.data as Record<string, unknown>;
  }

  private async dispatchRead(
    name: string,
    rawArguments: unknown,
  ): Promise<unknown> {
    if (this.options.queries.has(name)) {
      const result = await this.options.queries.execute(name, rawArguments);
      if (
        name === "get_block" &&
        result.ok &&
        typeof rawArguments === "object" &&
        rawArguments !== null &&
        "position" in rawArguments
      ) {
        const position = (rawArguments as {
          position: { x: number; y: number; z: number };
        }).position;
        const dimension = this.options.currentDimension?.();
        if (dimension) {
          const blockName =
            typeof result.value === "object" &&
            result.value !== null &&
            "name" in result.value &&
            typeof result.value.name === "string"
              ? result.value.name
              : null;
          await this.options.landmarks.verifyBlock(
            dimension,
            position,
            blockName,
            this.options.isPositionLoaded?.(position) ?? false,
          );
        }
      }
      return result;
    }

    const input = this.parseFixedArguments({
      id: "validation",
      name,
      arguments: JSON.stringify(rawArguments),
    });
    switch (name) {
      case "list_skills":
        return success(this.options.skills.list());
      case "load_skill":
        return success(
          await this.options.skillLoader.load(input.name as string),
        );
      case "get_capability_schemas": {
        const names = input.names as string[];
        const unknown = names.filter(
          (capability) => !this.options.capabilities.has(capability),
        );
        if (unknown.length > 0) {
          return failure(
            "UNKNOWN_CAPABILITY",
            `Unknown capabilities: ${unknown.join(", ")}.`,
            {
              unknown,
              available: this.options.capabilities
                .list()
                .map(({ name: capability }) => capability),
            },
          );
        }
        return success({
          capabilities: names.map((capabilityName) => {
            const capability =
              this.options.capabilities.get(capabilityName);
            if (!capability) {
              throw new Error(
                `Capability "${capabilityName}" disappeared.`,
              );
            }
            return {
              name: capability.name,
              description: capability.description,
              inputSchema: toJsonSchema(capability.inputSchema),
            };
          }),
        });
      }
      case "list_landmarks":
        return success(this.options.landmarks.list());
      default:
        return failure("TOOL_NOT_FOUND", `Unknown tool "${name}".`);
    }
  }

  private validateTasks(value: unknown): TaskSpec[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ModelResponseError("tasks must be a non-empty array.");
    }
    return value.map((candidate, index) =>
      this.validateTask(candidate, index),
    );
  }

  private validateTask(value: unknown, index: number): TaskSpec {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { capability?: unknown }).capability !== "string"
    ) {
      throw new ModelResponseError(`tasks.${index} is malformed.`);
    }
    const candidate = value as {
      capability: string;
      input?: unknown;
      timeoutMs?: unknown;
    };
    if (!this.options.capabilities.has(candidate.capability)) {
      throw new ModelResponseError(
        `tasks.${index}.capability "${candidate.capability}" is unknown.`,
      );
    }
    const validation = this.options.capabilities.validateInput(
      candidate.capability,
      candidate.input,
    );
    if (!validation.ok) {
      throw new ModelResponseError(
        `tasks.${index}.input is invalid for "${candidate.capability}".`,
      );
    }
    if (
      candidate.timeoutMs !== undefined &&
      (!Number.isInteger(candidate.timeoutMs) ||
        (candidate.timeoutMs as number) <= 0)
    ) {
      throw new ModelResponseError(
        `tasks.${index}.timeoutMs must be a positive integer.`,
      );
    }
    return {
      capability: candidate.capability,
      input: validation.input,
      ...(candidate.timeoutMs === undefined
        ? {}
        : { timeoutMs: candidate.timeoutMs as number }),
    };
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelResponseError("Tool arguments are not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new ModelResponseError("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function invalidArgumentsMessage(
  name: string,
  issues: readonly { path: (string | number)[]; message: string }[],
): string {
  const details = issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return `Invalid arguments for "${name}": ${details}`;
}

function success(value: unknown): { ok: true; value: unknown } {
  return { ok: true, value };
}

function failure(
  code: string,
  message: string,
  facts?: unknown,
): { ok: false; error: unknown } {
  return {
    ok: false,
    error: facts ? { code, message, facts } : { code, message },
  };
}

function isSuccessfulResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === true
  );
}

function compactJson(value: unknown, maxChars: number): string {
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return json;
  return JSON.stringify({
    ok: false,
    error: {
      code: "RESULT_TOO_LARGE",
      message: `Tool result exceeded ${maxChars} characters.`,
    },
  });
}
