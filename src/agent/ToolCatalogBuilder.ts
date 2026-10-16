import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type { LLMTool } from "../llm/LLMClient";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import { EvaluateStepSchema, EVALUATE_STEP_DESCRIPTION } from "./StepEvaluationService";

const EmptySchema = z.object({}).strict();
export const fixedToolSchemas = {
  list_skills: EmptySchema,
  load_skill: z.object({ name: z.string().trim().min(1) }).strict(),
  list_landmarks: EmptySchema,
  evaluate_step: EvaluateStepSchema,
  finish_step: z.object({
    status: z.enum(["success", "failure", "needs_user"]),
    message: z.string().trim().min(1).max(1_000),
  }).strict(),
} satisfies Record<string, z.ZodTypeAny>;

const fixedDescriptions: Record<keyof typeof fixedToolSchemas, string> = {
  list_skills: "List available textual skills and their descriptions.",
  load_skill: "Load one textual skill with its complete instructions and dependencies.",
  list_landmarks: "List remembered important places and their status.",
  evaluate_step: EVALUATE_STEP_DESCRIPTION,
  finish_step: "Does: End this delegation and report to the coordinator.\nSuccess: The report was returned.\nLimits: Does not validate the task or complete the global checklist.\nNotes: Report observed results, failures, and remaining uncertainty.",
};

/** One stable actioner catalog: observations, native capabilities, and explicit handoff. */
export class ToolCatalogBuilder {
  private readonly tools: readonly LLMTool[];

  constructor(capabilities: CapabilityRegistry, queries: WorldQueryRegistry, additionalTools: readonly LLMTool[] = []) {
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
    this.tools = [...queryTools, ...capabilityTools, ...fixedTools, ...additionalTools];
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

/** Documentation for planning, generated from the actioner's actual tool definitions. */
export function formatToolReference(tools: readonly LLMTool[]): string {
  return tools.map(tool =>
    `### ${tool.name}\n\n${tool.description}\nArguments (JSON Schema): ${JSON.stringify(tool.parameters)}`,
  ).join("\n\n");
}
