import { z } from "zod";
import type { LLMTool, LLMToolCall } from "../llm/LLMClient";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import { ModelResponseError } from "./ModelResponseError";
import { toJsonSchema } from "./ToolCatalogBuilder";

const instruction = z.string().trim().min(1).max(1_000);
const step = z.number().int().min(1).max(10);
const schemas = {
  reply: z.object({ message: z.string().trim().min(1).max(2_000), outcome: z.enum(["answer", "success", "failure", "needs_user"]) }).strict(),
  ask_planner: z.object({ instruction }).strict(),
  run_step: z.object({ step, instruction }).strict(),
  complete_step: z.object({ step }).strict(),
  refresh_summary: z.object({}).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  reply: "Send a concise player-facing reply and end this request. Success requires a verified completed checklist.",
  ask_planner: "Ask the single-shot planner to replace the current checklist. The returned step numbers are 1-based indices of this new plan. This is the only way to create steps.",
  run_step: "Delegate one existing step of the CURRENT plan to the action agent. Wait for its report; this does not check off the step.",
  complete_step: "Check off one step of the CURRENT plan after comparing its matching successful action report with actual results and fresh state.",
  refresh_summary: "Generate and store a concise factual replacement summary in a separate LLM call. Returns an acknowledgement, not the summary text; the latest summary appears in the next system context.",
};

type WorkflowCall = { [K in keyof typeof schemas]: { name: K; input: z.infer<(typeof schemas)[K]> } }[keyof typeof schemas];
export type CoordinatorCall = WorkflowCall | { name: "query"; query: string; input: unknown };

export class CoordinatorTools {
  private readonly workflowTools: readonly LLMTool[];
  private readonly queryTools: readonly LLMTool[];

  constructor(private readonly queries: WorldQueryRegistry) {
    this.workflowTools = (Object.keys(schemas) as (keyof typeof schemas)[])
      .map((name) => ({ name, description: descriptions[name], parameters: toJsonSchema(schemas[name]) }));
    this.queryTools = queries.list().map(({ name, description }) => ({ name, description, parameters: toJsonSchema(queries.get(name)!.inputSchema) }));
  }

  catalog(): LLMTool[] {
    return [
      ...this.workflowTools,
      ...this.queryTools,
    ];
  }

  parse(call: LLMToolCall): CoordinatorCall {
    if (!this.catalog().some((tool) => tool.name === call.name)) {
      throw new ModelResponseError(`Unknown tool "${call.name}".`);
    }
    let raw: unknown;
    try { raw = JSON.parse(call.arguments); }
    catch { throw new ModelResponseError("Tool arguments are not valid JSON."); }
    const name = call.name as keyof typeof schemas;
    const schema = Object.hasOwn(schemas, name) ? schemas[name] : this.queries.get(call.name)!.inputSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelResponseError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    return Object.hasOwn(schemas, name)
      ? { name, input: parsed.data } as WorkflowCall
      : { name: "query", query: call.name, input: parsed.data };
  }
}
