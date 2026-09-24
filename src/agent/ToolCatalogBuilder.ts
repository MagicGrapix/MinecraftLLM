import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { LLMTool } from "../llm/LLMClient";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import type { AgentPermissionMode } from "./AgentToolBridge";

const EmptySchema = z.object({}).strict();
const CapabilitySchemaNamesSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(4);
export const TaskEnvelopeSchema = z
  .object({
    capability: z.string().min(1),
    input: z.record(z.unknown()),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const fixedToolSchemas = {
  list_skills: EmptySchema,
  load_skill: z.object({ name: z.string().min(1) }).strict(),
  get_capability_schemas: z
    .object({ names: CapabilitySchemaNamesSchema })
    .strict(),
  list_landmarks: EmptySchema,
  set_plan: z
    .object({ tasks: z.array(TaskEnvelopeSchema).min(1) })
    .strict(),
  continue_plan: EmptySchema,
  finish_run: z
    .object({
      status: z.enum(["success", "failure", "needs_user"]),
      message: z.string().trim().min(1).max(1_000),
    })
    .strict(),
} satisfies Record<string, z.ZodTypeAny>;

const fixedDescriptions: Record<keyof typeof fixedToolSchemas, string> = {
  list_skills: "List available textual skills and their descriptions.",
  load_skill:
    "Load one textual skill with its complete instructions and dependencies.",
  get_capability_schemas:
    "Load exact input schemas for one to four capabilities before creating TaskSpecs.",
  list_landmarks: "List remembered important places and their status.",
  set_plan:
    "Create or replace remaining TaskSpecs. This saves a plan but never starts an action.",
  continue_plan:
    "Authorize exactly the next existing TaskSpec after reviewing current state.",
  finish_run:
    "Finish explicitly, clear remaining tasks, and report success, failure, or a need for user input.",
};

const readToolNames = new Set([
  "list_skills",
  "load_skill",
  "get_capability_schemas",
  "list_landmarks",
]);

export const decisionToolNames = new Set([
  "set_plan",
  "continue_plan",
  "finish_run",
]);

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
      Object.entries(fixedToolSchemas).map(([name, schema]) => [
        name,
        {
          name,
          description:
            fixedDescriptions[name as keyof typeof fixedToolSchemas],
          parameters: toJsonSchema(schema),
        },
      ]),
    );
  }

  build(mode: AgentPermissionMode): readonly LLMTool[] {
    return [
      ...this.queryTools,
      ...[...this.fixedTools.values()].filter(
        (tool) =>
          readToolNames.has(tool.name) ||
          (mode === "action" && decisionToolNames.has(tool.name)),
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
