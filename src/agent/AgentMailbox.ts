import type { ExecutionEvent } from "../execution/ExecutionController";

export type AgentWakeEvent =
  | {
      readonly type: "user_message";
      readonly username: string;
      readonly text: string;
      readonly receivedAt: number;
      readonly generationId: number;
      readonly readonlyOnly: boolean;
    }
  | {
      readonly type: "resume_requested";
      readonly username: string;
      readonly receivedAt: number;
      readonly generationId: number;
    }
  | {
      readonly type: "execution_finished";
      readonly event: Extract<ExecutionEvent, { type: "task_finished" }>;
    }
  | {
      readonly type: "execution_idle";
      readonly event: Extract<ExecutionEvent, { type: "queue_idle" }>;
    }
  | { readonly type: "startup" };

export class AgentMailbox {
  private readonly queue: AgentWakeEvent[] = [];
  private waiter: ((event: AgentWakeEvent | null) => void) | null = null;
  private closed = false;

  push(event: AgentWakeEvent): boolean {
    if (this.closed) return false;
    const duplicateIndex = this.coalescedIndex(event);
    if (duplicateIndex >= 0) {
      this.queue[duplicateIndex] = event;
      this.queue.sort((left, right) => priority(right) - priority(left));
      return true;
    }

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(event);
      return true;
    }
    this.queue.push(event);
    this.queue.sort((left, right) => priority(right) - priority(left));
    return true;
  }

  take(): Promise<AgentWakeEvent | null> {
    const event = this.queue.shift();
    if (event) return Promise.resolve(event);
    if (this.closed) return Promise.resolve(null);
    if (this.waiter) {
      throw new Error("AgentMailbox supports only one consumer.");
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(null);
  }

  get size(): number {
    return this.queue.length;
  }

  private coalescedIndex(event: AgentWakeEvent): number {
    if (
      event.type === "user_message" ||
      event.type === "resume_requested"
    ) {
      return -1;
    }
    return this.queue.findIndex((queued) => {
      if (queued.type !== event.type) return false;
      if (
        queued.type === "execution_finished" &&
        event.type === "execution_finished"
      ) {
        return queued.event.task.id === event.event.task.id;
      }
      return true;
    });
  }
}

function priority(event: AgentWakeEvent): number {
  if (event.type === "resume_requested") return 50;
  if (event.type === "user_message") return 40;
  if (event.type === "execution_finished") {
    return event.event.result.ok ? 20 : 30;
  }
  if (event.type === "execution_idle") return 10;
  return 0;
}
