import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { LLMTool } from "../llm/LLMClient";
import { PositionSchema } from "../shared/types";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import type { AgentPermissionMode } from "./AgentToolBridge";

const EmptySchema = z.object({}).strict();
const RevisionSchema = z.number().int().nonnegative();
const CapabilitySchemaNamesSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(4);
const TaskEnvelopeSchema = z
  .object({
    capability: z.string().min(1),
    input: z.record(z.unknown()),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const fixedToolSchemas = {
  get_execution_snapshot: EmptySchema,
  list_skills: EmptySchema,
  load_skill: z.object({ name: z.string().min(1) }).strict(),
  get_capability_schemas: z
    .object({ names: CapabilitySchemaNamesSchema })
    .strict(),
  list_landmarks: EmptySchema,
  enqueue_tasks: z
    .object({
      tasks: z.array(TaskEnvelopeSchema).min(1),
      expectedRevision: RevisionSchema,
    })
    .strict(),
  replace_pending_tasks: z
    .object({
      tasks: z.array(TaskEnvelopeSchema),
      expectedRevision: RevisionSchema,
    })
    .strict(),
  prepend_task: z
    .object({
      task: TaskEnvelopeSchema,
      expectedRevision: RevisionSchema,
    })
    .strict(),
  remove_pending_task: z
    .object({
      taskId: z.string().min(1),
      expectedRevision: RevisionSchema,
    })
    .strict(),
  clear_pending_tasks: z
    .object({ expectedRevision: RevisionSchema })
    .strict(),
  pause_execution: z
    .object({ expectedRevision: RevisionSchema })
    .strict(),
  resume_execution: z
    .object({ expectedRevision: RevisionSchema })
    .strict(),
  abort_current_task: z
    .object({
      expectedRevision: RevisionSchema,
      reason: z.string().min(1).max(240).optional(),
    })
    .strict(),
  remember_landmark: z
    .object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum([
        "crafting_table",
        "chest",
        "bed",
        "base",
        "custom",
      ]),
      dimension: z.string().trim().min(1),
      position: PositionSchema,
      source: z.enum(["observed", "user", "agent"]).default("agent"),
      pinned: z.boolean().default(true),
    })
    .strict(),
  forget_landmark: z.object({ id: z.string().min(1) }).strict(),
} satisfies Record<string, z.ZodTypeAny>;

const fixedDescriptions: Record<keyof typeof fixedToolSchemas, string> = {
  get_execution_snapshot:
    "Read the current execution revision, mode, active task, and pending tasks.",
  list_skills: "List available textual skills and their descriptions.",
  load_skill:
    "Load one textual skill with its complete instructions and dependencies.",
  get_capability_schemas:
    "Load the exact input schemas for one to four capabilities before adding those capabilities to a TaskSpec. Request only the capabilities needed for the current short plan.",
  list_landmarks: "List remembered important places and their status.",
  enqueue_tasks:
    "Append validated physical tasks to the future execution queue. This is the normal way to perform capabilities such as goto, dig, equip, place, craft, or attack; capability names are not direct tools.",
  replace_pending_tasks:
    "Atomically replace all pending tasks without changing the active task.",
  prepend_task: "Insert one validated task at the front of the pending queue.",
  remove_pending_task: "Remove one pending task by its internal task id.",
  clear_pending_tasks: "Clear all pending tasks.",
  pause_execution:
    "Pause future queue draining without interrupting the active task.",
  resume_execution: "Resume draining the physical execution queue.",
  abort_current_task:
    "Pause execution and interrupt the currently active physical task.",
  remember_landmark:
    "Persist an important place using observed or user-provided coordinates.",
  forget_landmark: "Remove one persisted landmark by id.",
};

const readTools = new Set([
  "get_execution_snapshot",
  "list_skills",
  "load_skill",
  "get_capability_schemas",
  "list_landmarks",
]);
const queueTools = new Set([
  "enqueue_tasks",
  "replace_pending_tasks",
  "prepend_task",
  "remove_pending_task",
  "clear_pending_tasks",
]);
const memoryTools = new Set(["remember_landmark", "forget_landmark"]);

export class ToolCatalogBuilder {
  private readonly queryTools: readonly LLMTool[];
  private readonly fixedTools: ReadonlyMap<string, LLMTool>;

  constructor(
    private readonly capabilities: CapabilityRegistry,
    queries: WorldQueryRegistry,
    _skills: SkillRegistry,
  ) {
    this.queryTools = queries.list().map(({ name, description }) => {
      const query = queries.get(name);
      if (!query) throw new Error(`Query "${name}" disappeared.`);
      return {
        name,
        description,
        parameters: toJsonSchema(query.inputSchema),
      };
    });

    this.fixedTools = new Map(
      Object.entries(fixedToolSchemas).map(([name, schema]) => {
        return [
          name,
          {
            name,
            description:
              fixedDescriptions[name as keyof typeof fixedToolSchemas],
            parameters: toJsonSchema(schema),
          },
        ];
      }),
    );
  }

  build(mode: AgentPermissionMode): readonly LLMTool[] {
    const allowed = (name: string): boolean => {
      if (readTools.has(name)) return true;
      if (mode === "readonly") return false;
      if (queueTools.has(name) || memoryTools.has(name)) return true;
      if (mode === "acting") return true;
      return (
        mode === "resume_review" &&
        (name === "pause_execution" || name === "abort_current_task")
      );
    };

    return [
      ...this.queryTools,
      ...[...this.fixedTools.values()].filter((tool) =>
        allowed(tool.name),
      ),
    ];
  }

  capabilitySummaries(): readonly {
    name: string;
    description: string;
  }[] {
    return [...this.capabilities.list()];
  }
}

export function toJsonSchema(
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  });
  const result = { ...converted } as Record<string, unknown>;
  delete result.$schema;
  return result;
}
