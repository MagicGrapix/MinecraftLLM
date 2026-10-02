import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { LLMTool } from "../llm/LLMClient";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";

const EmptySchema = z.object({}).strict();
export const fixedToolSchemas = {
  list_skills: EmptySchema,
  load_skill: z.object({ name: z.string().trim().min(1) }).strict(),
  list_landmarks: EmptySchema,
  finish_step: z.object({
    status: z.enum(["success", "failure", "needs_user"]),
    message: z.string().trim().min(1).max(1_000),
  }).strict(),
} satisfies Record<string, z.ZodTypeAny>;

const fixedDescriptions: Record<keyof typeof fixedToolSchemas, string> = {
  list_skills: "List available textual skills and their descriptions.",
  load_skill: "Load one textual skill with its complete instructions and dependencies.",
  list_landmarks: "List remembered important places and their status.",
  finish_step: "Return a concise factual report for this delegated step to the coordinator. This does not check off the global checklist or complete the overall player request.",
};

/** One stable actioner catalog: observations, native capabilities, and explicit handoff. */
export class ToolCatalogBuilder {
  private readonly tools: readonly LLMTool[];

  constructor(capabilities: CapabilityRegistry, queries: WorldQueryRegistry) {
    const queryTools = queries.list().map(({ name, description }) => ({
      name, description, parameters: toJsonSchema(queries.get(name)!.inputSchema),
    }));
    const capabilityTools = capabilities.list().map(({ name, description }) => ({
      name, description, parameters: toJsonSchema(capabilities.get(name)!.inputSchema),
    }));
    const fixedTools = Object.entries(fixedToolSchemas).map(([name, schema]) => ({
      name, description: fixedDescriptions[name as keyof typeof fixedToolSchemas],
      parameters: toJsonSchema(schema),
    }));
    this.tools = [...queryTools, ...capabilityTools, ...fixedTools];
    if (new Set(this.tools.map((tool) => tool.name)).size !== this.tools.length) {
      throw new Error("Action tool names must be unique across queries, capabilities and handoff tools.");
    }
  }

  build(): readonly LLMTool[] { return this.tools; }
}

export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
  const result = { ...converted } as Record<string, unknown>;
  delete result.$schema;
  return result;
}
