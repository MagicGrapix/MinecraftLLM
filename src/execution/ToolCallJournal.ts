import { writeTrace } from "../TraceLog";
import { inventoryDelta } from "../runtime/InventoryAdapter";

export type InventorySnapshot = Readonly<Record<string, number>>;

export interface ToolCallRecord {
  readonly actionNumber: number;
  readonly tool: string;
  readonly tracksInventory: boolean;
  readonly before: InventorySnapshot | null;
  after: InventorySnapshot | null;
  completed: boolean;
  ok?: boolean;
  readonly context?: { agent: string; generationId: number; toolCallId: string; arguments: string };
}

/** Shared by coordinator, Architect and actioner. Numbers last for the session; records last for the request. */
export class ToolCallJournal {
  private nextNumber = 0;
  private readonly records = new Map<number, ToolCallRecord>();

  constructor(private readonly readInventory: () => InventorySnapshot | null) {}

  startRequest(): void {
    if ([...this.records.values()].some((record) => !record.completed)) {
      throw new Error("Cannot clear a journal with running tool calls.");
    }
    this.records.clear();
  }

  start(tool: string, tracksInventory: boolean, context?: ToolCallRecord["context"]): number {
    const actionNumber = ++this.nextNumber;
    const record: ToolCallRecord = {
      actionNumber, tool, tracksInventory,
      before: tracksInventory ? this.snapshot() : null,
      after: null, completed: false, ...(context ? { context: { ...context } } : {}),
    };
    this.records.set(actionNumber, record);
    writeTrace("tool.started", structuredClone(record));
    return actionNumber;
  }

  complete(actionNumber: number, ok: boolean, result?: string): void {
    const record = this.records.get(actionNumber);
    if (!record || record.completed) return;
    record.after = record.tracksInventory ? this.snapshot() : null;
    record.completed = true;
    record.ok = ok;
    // Full tool output belongs in the trace, not the retained inventory journal.
    writeTrace("tool.completed", { ...structuredClone(record), ...(result === undefined ? {} : { result }) });
  }

  get(actionNumber: number): ToolCallRecord | undefined {
    const record = this.records.get(actionNumber);
    return record ? structuredClone(record) : undefined;
  }

  private snapshot(): InventorySnapshot | null {
    try {
      const inventory = this.readInventory();
      return inventory === null ? null : structuredClone(inventory);
    } catch {
      // Disconnected/unavailable is not an empty inventory.
      return null;
    }
  }
}

/** Deterministic, Git-style changed lines only. No LLM call or Git repository. */
export function formatInventoryDiff(record: ToolCallRecord): string {
  if (record.before === null || record.after === null) throw new Error("Inventory snapshot unavailable.");
  const names = Object.keys(inventoryDelta(record.before, record.after)).sort();
  if (!names.length) return `No inventory changes during action #${record.actionNumber}.`;
  const lines = names.flatMap((name) => [
    ...(record.before![name] ? [`- ${name}: ${record.before![name]}`] : []),
    ...(record.after![name] ? [`+ ${name}: ${record.after![name]}`] : []),
  ]);
  return [`--- before action #${record.actionNumber}`, `+++ after action #${record.actionNumber}`, ...lines].join("\n");
}

/** Add metadata without changing the native tool-call ID or the result contract. */
export function numberedToolResult(actionNumber: number, content: string): string {
  return JSON.stringify({ ...JSON.parse(content), actionNumber });
}
