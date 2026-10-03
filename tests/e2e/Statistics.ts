import type { TraceEvent } from "./types";

export interface Activity {
  kind: "llm" | "tool";
  agent: string;
  label: string;
  startMs: number;
  durationMs: number | null;
  status: "completed" | "failed" | "incomplete";
  details: unknown;
}
export interface Statistics {
  llmCalls: number;
  toolCalls: number;
  failedTools: number;
  tools: Record<string, { count: number; failed: number; durationMs: number }>;
  promptTokens: number;
  completionTokens: number;
  activities: Activity[];
}

/** Counts starts once; nested run_step time is never added to capability time as a total. */
export function summarizeTrace(events: readonly TraceEvent[]): Statistics {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const origin = Date.parse(sorted.find((e) => e.event === "workflow.accepted")?.timestamp ?? sorted[0]?.timestamp ?? new Date(0).toISOString());
  const tools = new Map<number, Activity>();
  const llm = new Map<string, Activity>();
  const stats: Statistics = { llmCalls: 0, toolCalls: 0, failedTools: 0, tools: {}, promptTokens: 0, completionTokens: 0, activities: [] };
  const key = (d: any) => JSON.stringify([d.generationId, d.phase, d.reflection, d.round, d.attempt]);
  for (const event of sorted) {
    const d = event.data;
    if (!d || typeof d !== "object") continue;
    const at = Date.parse(event.timestamp) - origin;
    if (event.event === "tool.started" && !tools.has(d.actionNumber)) {
      const activity: Activity = { kind: "tool", agent: d.context?.agent ?? "unknown", label: `#${d.actionNumber} ${d.tool}`, startMs: at, durationMs: null, status: "incomplete", details: d };
      tools.set(d.actionNumber, activity);
      stats.activities.push(activity);
      stats.toolCalls++;
      (stats.tools[d.tool] ??= { count: 0, failed: 0, durationMs: 0 }).count++;
    }
    if (event.event === "tool.completed") {
      const activity = tools.get(d.actionNumber);
      if (!activity || activity.status !== "incomplete") continue;
      activity.durationMs = Math.max(0, at - activity.startMs);
      activity.status = d.ok ? "completed" : "failed";
      activity.details = d;
      stats.tools[d.tool]!.durationMs += activity.durationMs;
      if (!d.ok) { stats.failedTools++; stats.tools[d.tool]!.failed++; }
    }
    if (event.event === "llm.request") {
      const activity: Activity = { kind: "llm", agent: d.phase ?? "unknown", label: `LLM ${d.phase ?? ""}`, startMs: at, durationMs: null, status: "incomplete", details: { model: d.body?.model, request: d.body } };
      llm.set(key(d), activity);
      stats.activities.push(activity);
      stats.llmCalls++;
    }
    if (event.event === "llm.raw_response" || event.event === "llm.error" || event.event === "llm.validation_error") {
      const activity = llm.get(key(d));
      if (!activity) continue;
      activity.durationMs = Math.max(0, at - activity.startMs);
      activity.status = event.event === "llm.raw_response" ? "completed" : "failed";
      activity.details = event.event !== "llm.raw_response" ? { ...activity.details as object, error: d } : { ...activity.details as object, response: d.raw };
      if (event.event === "llm.raw_response") {
        stats.promptTokens += Number(d.raw?.usage?.prompt_tokens ?? 0);
        stats.completionTokens += Number(d.raw?.usage?.completion_tokens ?? 0);
      }
    }
  }
  return stats;
}
