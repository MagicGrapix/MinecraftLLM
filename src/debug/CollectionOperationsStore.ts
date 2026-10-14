export interface CollectionOperation {
  index: number;
  operation: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  args?: unknown;
  durationMs?: number;
  result?: unknown;
  error?: string;
}
interface CollectionRun {
  taskId: string;
  actionNumber: number;
  toolCallId?: string;
  operations: Map<number, CollectionOperation>;
  dropped: number;
}

/** UI-only bounded projection. Full events stay in JSONL; never copied into an LLM round. */
export class CollectionOperationsStore {
  private readonly runs = new Map<string, CollectionRun>();
  constructor(private readonly maxRuns = 64, private readonly maxOperations = 2000) {}

  record(event: string, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const d = raw as Record<string, unknown>;
    if (typeof d.taskId !== "string") return;
    if (event === "action.task_started" && d.capability === "collect_resource" && Number.isSafeInteger(d.actionNumber)) {
      this.runs.set(d.taskId, { taskId: d.taskId, actionNumber: d.actionNumber as number,
        ...(typeof d.toolCallId === "string" ? { toolCallId: d.toolCallId } : {}), operations: new Map(), dropped: 0 });
      while (this.runs.size > this.maxRuns) this.runs.delete(this.runs.keys().next().value!);
      return;
    }
    if (event !== "collect.event" || !Number.isSafeInteger(d.index)) return;
    const run = this.runs.get(d.taskId); if (!run) return;
    const index = d.index as number;
    if (d.event === "operation_started" && typeof d.operation === "string" && !run.operations.has(index)) {
      run.operations.set(index, { index, operation: d.operation, startedAt: Date.now(), status: "running", args: structuredClone(d.args) });
      while (run.operations.size > this.maxOperations) { run.operations.delete(run.operations.keys().next().value!); run.dropped++; }
    } else if (d.event === "operation_finished" || d.event === "operation_failed") {
      const operation = run.operations.get(index); if (!operation) return;
      const failed = d.event === "operation_failed" || !!d.result && typeof d.result === "object" && (d.result as { ok?: boolean }).ok === false;
      Object.assign(operation, { status: failed ? "failed" : "completed", durationMs: d.durationMs,
        ...(d.result === undefined ? {} : { result: structuredClone(d.result) }),
        ...(typeof d.error === "string" ? { error: d.error } : {}) });
    }
  }

  page(actionNumber: number, after = 0, limit = 50) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid collection page: after >= 0, limit 1–100.");
    const run = [...this.runs.values()].find(r => r.actionNumber === actionNumber); if (!run) return null;
    const remaining = [...run.operations.values()].filter(o => o.index > after).sort((a, b) => a.index - b.index);
    const operations = remaining.slice(0, limit);
    return structuredClone({ taskId: run.taskId, actionNumber, toolCallId: run.toolCallId, dropped: run.dropped,
      retained: run.operations.size, operations, nextAfter: remaining.length > limit ? operations.at(-1)!.index : null });
  }
  clear(): void { this.runs.clear(); }
}
