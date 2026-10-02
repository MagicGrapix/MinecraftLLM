import type { InspectorPresentation, InspectorRound, InspectorToolExecution } from "./InspectorTypes";

type PresentationInput = Pick<InspectorRound,
  "phase" | "status" | "contextSnapshot" | "request" | "response" |
  "decision" | "toolExecutions" | "error" | "validationError"
>;

const failureStatuses = new Set(["error", "invalid_response", "token_limit_discarded", "tool_round_limit"]);

/** Read-only display projection: never changes prompts, tool arguments, or results. */
export function describeInspectorRound(round: PresentationInput): InspectorPresentation {
  const context = record(round.contextSnapshot);
  const delegation = record(context.delegation ?? parseObject(context.objective));
  const task = record(context.task);
  const decision = record(round.decision);
  const calls = round.response?.toolCalls.map(record) ?? [];
  const selectedStep = record(decision.input).step ?? parseObject(calls[0]?.arguments).step;
  const steps = Array.isArray(task.steps) ? task.steps.map(record) : [];
  const step = record(delegation.step ?? steps.find((item) => item.step === selectedStep));
  const lastUser = round.request?.messages.map(record).filter((message) => message.role === "user").at(-1);
  const requestTitle = text(task.objective) || text(delegation.userObjective) ||
    text(context.objective) || text(context.currentMessage) || text(lastUser?.content) || "Internal request";

  const executions = round.toolExecutions.map(describeExecution);
  const issue = text(round.error) || text(round.validationError);
  const failed = failureStatuses.has(round.status) || Boolean(issue) ||
    round.response?.finishReason === "length" || executions.some((execution) => execution.failed);
  const result = record(round.decision ?? parseObject(round.response?.content));
  const activity = executions.length
    ? executions.map((execution) => execution.activity).join(" · ")
    : calls.length
      ? calls.map((call) => describeCall(text(call.name), parseObject(call.arguments))).join(" · ")
      : round.phase === "planner" ? "Create checklist"
        : round.phase === "summary" || round.phase === "memory" ? "Update summary"
          : round.phase === "coordinator" ? "Choose next sequence"
            : round.phase === "intent" ? "Classify intent"
              : round.phase === "question" ? "Reply" : "Choose next action";
  let outcome: string;
  if (issue) outcome = `Failed — ${issue}`;
  else if (round.response?.finishReason === "length") outcome = "Failed — response reached the token limit";
  else if (executions.length) outcome = executions.map((execution, index) =>
    `${executions.length > 1 ? `${round.toolExecutions[index]!.name}: ` : ""}${execution.outcome}`,
  ).join(" · ");
  else if (failureStatuses.has(round.status)) outcome = `Failed — ${round.status.replaceAll("_", " ")}`;
  else if (round.status === "aborted" || round.status === "superseded") outcome = "Interrupted";
  else if (Array.isArray(result.steps)) outcome = `Checklist created — ${result.steps.length} steps`;
  else outcome = text(result.message) || text(result.summary) || text(round.response?.content) ||
    (round.status === "in_progress" ? "In progress" : "Completed");

  return {
    requestTitle: compact(requestTitle, 240),
    agentLabel: agentLabel(round.phase),
    ...(text(step.title) ? { stepLabel: `Step ${step.step ?? "?"} — ${compact(text(step.title), 160)}` }
      : round.phase === "planner" && text(context.instruction)
        ? { stepLabel: compact(text(context.instruction), 160) } : {}),
    activity: compact(activity, 240),
    outcome: compact(outcome, 300),
    failed,
  };
}

function describeExecution(execution: InspectorToolExecution) {
  const input = parseObject(execution.arguments);
  const raw = parseObject(execution.result);
  const result = record(raw.result ?? raw);
  const value = record(result.value ?? result);
  const report = record(value.report ?? value);
  const failedAction = Array.isArray(report.outcomes)
    ? report.outcomes.map(record).find((item) => record(item.result).ok === false) : undefined;
  const error = record(record(failedAction?.result).error ?? result.error);
  const claimedStatus = text(report.status) || text(input.status) || text(input.outcome);
  const failed = execution.ok === false || result.ok === false || Boolean(failedAction) ||
    claimedStatus === "failure";
  const activity = describeCall(execution.name, input, raw);
  let outcome: string;
  if (failed) outcome = `Failed${text(error.code) ? `: ${error.code}` : ""} — ${
    text(error.message) || text(report.message) || text(input.message) || "execution failed"
  }`;
  else if (claimedStatus) outcome = `${
    claimedStatus === "needs_user" ? "Needs user" : claimedStatus === "interrupted" ? "Interrupted"
      : claimedStatus === "success" ? "Success" : claimedStatus === "answer" ? "Reply sent" : claimedStatus
  }${text(report.message) || text(input.message) ? ` — ${text(report.message) || text(input.message)}` : ""}`;
  else if (execution.result === undefined) outcome = "In progress";
  else if (Array.isArray(value.steps)) outcome = `Checklist created — ${value.steps.length} steps`;
  else if (Array.isArray(value.remainingPlan)) outcome = `Plan saved — ${value.remainingPlan.length} actions`;
  else if (execution.name === "complete_step") outcome = `Step ${input.step} marked complete`;
  else if (execution.name === "refresh_summary") outcome = "Summary updated";
  else if (Array.isArray(result.value)) outcome = `Completed — ${result.value.length} results`;
  else if (Array.isArray(value.items)) outcome = `Completed — ${value.items.length} inventory stacks`;
  else outcome = `Succeeded${text(value.block) ? ` — ${value.block}` : ""}`;
  return { activity, outcome, failed };
}

function describeCall(name: string, input: Record<string, unknown>, raw: Record<string, unknown> = {}): string {
  if (name === "continue_plan" && text(record(raw.task).capability)) {
    return `${name} → ${record(raw.task).capability}`;
  }
  if (name === "set_plan" && Array.isArray(input.tasks)) {
    return `${name} → ${input.tasks.map((task) => text(record(task).capability)).filter(Boolean).join(" → ")}`;
  }
  if (name === "run_step" || name === "complete_step") return `${name} → Step ${input.step ?? "?"}`;
  if (name === "get_capability_schemas" && Array.isArray(input.names)) return `${name} → ${input.names.join(", ")}`;
  if (name === "load_skill" && text(input.name)) return `${name} → ${input.name}`;
  return name || "Tool call";
}

function agentLabel(phase: InspectorRound["phase"]): string {
  if (phase.startsWith("actioner_") || phase === "planning" || phase === "review") return "Actioner";
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function compact(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
