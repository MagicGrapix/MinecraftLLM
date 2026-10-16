import { z } from "zod";
import type { LLMTool, LLMToolCall } from "../llm/LLMClient";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import { ModelResponseError } from "./ModelResponseError";
import { toJsonSchema } from "./ToolCatalogBuilder";
import { invalidToolArguments, parseToolArguments } from "../shared/ToolArgumentFeedback";
import { EvaluateStepSchema, EVALUATE_STEP_DESCRIPTION } from "./StepEvaluationService";

const instruction = z.string().trim().min(1).max(1_000);
const step = z.number().int().min(1).max(10);
const schemas = {
  reply: z.object({ message: z.string().trim().min(1).max(2_000), outcome: z.enum(["answer", "success", "failure", "needs_user"]) }).strict(),
  ask_planner: z.object({ instruction }).strict(),
  ask_architect: z.object({ instruction }).strict(),
  run_step: z.object({ step }).strict(),
  evaluate_step: EvaluateStepSchema,
  complete_step: z.object({ step }).strict(),
  refresh_summary: z.object({}).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  reply: "Send a concise player-facing reply and end this request. Success requires a verified completed checklist.",
  ask_planner: "Ask the planner to consult recipe knowledge and return a replacement checklist. Pass the objective, player constraints, observed facts and blockers; let the planner decide subgoals and crafting prerequisites. Do not dictate a recipe or tool sequence. Only a valid submit_plan replaces the checklist. Returned step numbers are 1-based indices. This is the only way to create steps.",
  ask_architect: "Does: Delegate a drawing to the Architect with the player's constraints.\nSuccess: Selects a validated saved blueprint and its calculated material bill; clears the previous checklist/reports.\nLimits: Does not build, acquire resources, or prove the design meets the request.\nNotes: Design-only requests end with a reply. For construction, ask the planner AFTER the blueprint is accepted. Failure keeps the previous selection; never treat it as the requested new design.",
  run_step: "Delegate one existing step of the CURRENT plan with its goal, success criterion and constraints. Let the action agent choose execution tools and positions. Wait for its report; this does not check off the step.",
  evaluate_step: EVALUATE_STEP_DESCRIPTION,
  complete_step: "Does: Mark one step complete after freshly evaluating its inventory checks, if defined.\nSuccess: Checks passed and the checklist was updated.\nLimits: Checks alone do not prove the natural criterion or causation. No checks means semantic review only.\nNotes: Requires that step's latest successful report in this plan. Verify its evidence before calling; other steps' reports do not replace it. False or unknown checks prevent completion.",
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
    const names = new Set<string>();
    for (const tool of this.catalog()) {
      if (names.has(tool.name)) throw new Error(`Duplicate coordinator tool "${tool.name}"; workflow names are reserved.`);
      names.add(tool.name);
    }
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
    try { raw = parseToolArguments(call.name, call.arguments); }
    catch (error) { throw new ModelResponseError((error as Error).message); }
    const name = call.name as keyof typeof schemas;
    const schema = Object.hasOwn(schemas, name) ? schemas[name] : this.queries.get(call.name)!.inputSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelResponseError(invalidToolArguments(call.name, raw, parsed.error.issues, schema));
    return Object.hasOwn(schemas, name)
      ? { name, input: parsed.data } as WorkflowCall
      : { name: "query", query: call.name, input: parsed.data };
  }
}
