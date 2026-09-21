import type { z } from "zod";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { ExecutionController } from "../execution/ExecutionController";
import type { TaskSpec } from "../execution/Task";
import type { LLMToolCall } from "../llm/LLMClient";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { SkillLoader } from "../skills/SkillLoader";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import {
  fixedToolSchemas,
  toJsonSchema,
  ToolCatalogBuilder,
} from "./ToolCatalogBuilder";

export type AgentPermissionMode =
  | "readonly"
  | "planning_stopped"
  | "acting"
  | "resume_review";

export interface AgentToolExecutionContext {
  readonly permission: AgentPermissionMode;
  readonly manualStopped: boolean;
  readonly generationId: number;
}

export interface AgentToolResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly content: string;
}

interface AgentToolBridgeOptions {
  readonly controller: ExecutionController;
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
  "get_execution_snapshot",
  "list_skills",
  "load_skill",
  "get_capability_schemas",
  "list_landmarks",
]);
const queueToolNames = new Set([
  "enqueue_tasks",
  "replace_pending_tasks",
  "prepend_task",
  "remove_pending_task",
  "clear_pending_tasks",
]);
const memoryToolNames = new Set(["remember_landmark", "forget_landmark"]);

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

  async execute(
    call: LLMToolCall,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolResult> {
    const startedAt = Date.now();
    let result: unknown;
    let ok = false;

    try {
      if (!this.isKnownTool(call.name)) {
        result = this.options.capabilities.has(call.name)
          ? failure(
              "CAPABILITY_REQUIRES_QUEUE",
              `"${call.name}" is a capability, not a directly callable tool. Put it in a TaskSpec and submit it with enqueue_tasks, prepend_task, or replace_pending_tasks.`,
            )
          : failure("TOOL_NOT_FOUND", `Unknown tool "${call.name}".`);
      } else if (!this.isAllowed(call.name, context.permission)) {
        result = failure(
          "PERMISSION_DENIED",
          `Tool "${call.name}" is not allowed in ${context.permission} mode.`,
        );
      } else if (
        context.manualStopped &&
        call.name === "resume_execution"
      ) {
        result = failure(
          "MANUAL_STOP",
          "Execution is manually stopped; only an explicit chat resume may restart it.",
        );
      } else {
        const parsedArguments = parseArguments(call.arguments);
        result = await this.dispatch(call.name, parsedArguments);
      }
      ok = isSuccessfulResult(result);
    } catch (error: unknown) {
      result = failure(
        "TOOL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }

    console.info("Agent tool completed.", {
      generationId: context.generationId,
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

  private async dispatch(
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

    const schema = fixedToolSchemas[
      name as keyof typeof fixedToolSchemas
    ] as z.ZodTypeAny | undefined;
    if (!schema) {
      return failure("TOOL_NOT_FOUND", `Unknown tool "${name}".`);
    }
    const parsed = schema.safeParse(rawArguments);
    if (!parsed.success) {
      return failure("INVALID_ARGUMENT", `Invalid arguments for "${name}".`, {
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data as Record<string, unknown>;

    switch (name) {
      case "get_execution_snapshot":
        return success(this.options.controller.snapshot());
      case "list_skills":
        return success(this.options.skills.list());
      case "load_skill":
        return success(
          await this.options.skillLoader.load(input.name as string),
        );
      case "get_capability_schemas": {
        const names = input.names as string[];
        const unknown = names.filter(
          (name) => !this.options.capabilities.has(name),
        );
        if (unknown.length > 0) {
          return failure(
            "UNKNOWN_CAPABILITY",
            `Unknown capabilities: ${unknown.join(", ")}.`,
            {
              unknown,
              available: this.options.capabilities
                .list()
                .map(({ name }) => name),
            },
          );
        }
        return success({
          capabilities: names.map((name) => {
            const capability = this.options.capabilities.get(name);
            if (!capability) {
              throw new Error(`Capability "${name}" disappeared.`);
            }
            return {
              name: capability.name,
              description: capability.description,
              inputSchema: toJsonSchema(capability.inputSchema),
            };
          }),
          note: "Use these schemas only for the current generation. Runtime validation remains authoritative.",
        });
      }
      case "list_landmarks":
        return success(this.options.landmarks.list());
      case "enqueue_tasks": {
        const tasks = this.validateTasks(input.tasks);
        if (!tasks.ok) return tasks;
        return this.options.controller.enqueueMany(tasks.value, {
          expectedRevision: input.expectedRevision as number,
        });
      }
      case "replace_pending_tasks": {
        const tasks = this.validateTasks(input.tasks);
        if (!tasks.ok) return tasks;
        return this.options.controller.replacePending(tasks.value, {
          expectedRevision: input.expectedRevision as number,
        });
      }
      case "prepend_task": {
        const task = this.validateTask(input.task);
        if (!task.ok) return task;
        return this.options.controller.prepend(task.value, {
          expectedRevision: input.expectedRevision as number,
        });
      }
      case "remove_pending_task":
        return this.options.controller.removePending(
          input.taskId as string,
          { expectedRevision: input.expectedRevision as number },
        );
      case "clear_pending_tasks":
        return this.options.controller.clearPending({
          expectedRevision: input.expectedRevision as number,
        });
      case "pause_execution":
        return this.options.controller.pause({
          expectedRevision: input.expectedRevision as number,
        });
      case "resume_execution":
        return this.options.controller.resume({
          expectedRevision: input.expectedRevision as number,
        });
      case "abort_current_task":
        return this.options.controller.abortCurrent(
          (input.reason as string | undefined) ??
            "Interrupted by agent.",
          { expectedRevision: input.expectedRevision as number },
        );
      case "remember_landmark":
        return success(
          await this.options.landmarks.remember({
            name: input.name as string,
            kind: input.kind as
              | "crafting_table"
              | "chest"
              | "bed"
              | "base"
              | "custom",
            dimension: input.dimension as string,
            position: input.position as { x: number; y: number; z: number },
            source: input.source as "observed" | "user" | "agent",
            pinned: input.pinned as boolean,
          }),
        );
      case "forget_landmark":
        return success({
          forgotten: await this.options.landmarks.forget(
            input.id as string,
          ),
        });
      default:
        return failure("TOOL_NOT_FOUND", `Unknown tool "${name}".`);
    }
  }

  private validateTasks(value: unknown):
    | { ok: true; value: TaskSpec[] }
    | { ok: false; error: unknown } {
    if (!Array.isArray(value)) {
      return failure("INVALID_ARGUMENT", "tasks must be an array.");
    }
    const tasks: TaskSpec[] = [];
    for (const candidate of value) {
      const validated = this.validateTask(candidate);
      if (!validated.ok) return validated;
      tasks.push(validated.value);
    }
    return { ok: true, value: tasks };
  }

  private validateTask(value: unknown):
    | { ok: true; value: TaskSpec }
    | { ok: false; error: unknown } {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { capability?: unknown }).capability !== "string"
    ) {
      return failure("INVALID_TASK_SPEC", "Malformed TaskSpec.");
    }
    const candidate = value as {
      capability: string;
      input?: unknown;
      timeoutMs?: unknown;
    };
    if (!this.options.capabilities.has(candidate.capability)) {
      return failure(
        "INVALID_TASK_SPEC",
        `Unknown capability "${candidate.capability}".`,
      );
    }
    const validation = this.options.capabilities.validateInput(
      candidate.capability,
      candidate.input,
    );
    if (!validation.ok) {
      return failure(
        "INVALID_TASK_SPEC",
        `Invalid input for capability "${candidate.capability}".`,
        { issues: validation.issues },
      );
    }
    if (
      candidate.timeoutMs !== undefined &&
      (!Number.isInteger(candidate.timeoutMs) ||
        (candidate.timeoutMs as number) <= 0)
    ) {
      return failure(
        "INVALID_TASK_SPEC",
        "Task timeoutMs must be a positive integer.",
      );
    }
    return {
      ok: true,
      value: {
        capability: candidate.capability,
        input: validation.input,
        ...(candidate.timeoutMs === undefined
          ? {}
          : { timeoutMs: candidate.timeoutMs as number }),
      },
    };
  }

  private isAllowed(name: string, mode: AgentPermissionMode): boolean {
    if (this.options.queries.has(name) || readToolNames.has(name)) {
      return true;
    }
    if (mode === "readonly") return false;
    if (queueToolNames.has(name) || memoryToolNames.has(name)) return true;
    if (mode === "acting") {
      return (
        name === "pause_execution" ||
        name === "resume_execution" ||
        name === "abort_current_task"
      );
    }
    return (
      mode === "resume_review" &&
      (name === "pause_execution" || name === "abort_current_task")
    );
  }

  private isKnownTool(name: string): boolean {
    return (
      this.options.queries.has(name) ||
      Object.prototype.hasOwnProperty.call(fixedToolSchemas, name)
    );
  }
}

function parseArguments(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Tool arguments are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed;
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
