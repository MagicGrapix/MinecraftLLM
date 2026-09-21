import { randomUUID } from "node:crypto";

export interface ActivityEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly kind: string;
  readonly summary: string;
  readonly data?: unknown;
  readonly taskId?: string;
}

export interface NewActivityEntry {
  readonly kind: string;
  readonly summary: string;
  readonly data?: unknown;
  readonly taskId?: string;
}

export class RecentActivityBuffer {
  private readonly entries: ActivityEntry[] = [];

  constructor(
    readonly capacity = 15,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("RecentActivityBuffer capacity must be positive.");
    }
  }

  add(entry: NewActivityEntry): ActivityEntry {
    const stored: ActivityEntry = {
      id: this.createId(),
      timestamp: this.now(),
      kind: entry.kind,
      summary: entry.summary,
      ...(entry.data === undefined
        ? {}
        : { data: structuredClone(entry.data) }),
      ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
    };
    this.entries.push(stored);
    if (this.entries.length > this.capacity) this.entries.shift();
    return cloneEntry(stored);
  }

  list(): readonly ActivityEntry[] {
    return this.entries.map(cloneEntry);
  }
}

function cloneEntry(entry: ActivityEntry): ActivityEntry {
  return {
    ...entry,
    ...(entry.data === undefined
      ? {}
      : { data: structuredClone(entry.data) }),
  };
}
