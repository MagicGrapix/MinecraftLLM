import type { TaskExecutor } from "../execution/TaskExecutor";
import type { Task } from "../execution/Task";
import { failure, type TaskErrorCode, type TaskResult } from "../execution/TaskResult";
import type { LabWorld } from "./LabWorld";

interface PendingAction {
  readonly task: Task;
  readonly resolve: (result: TaskResult) => void;
}

export class LabExecutor implements TaskExecutor {
  private pending: PendingAction | null = null;

  constructor(private readonly world: LabWorld) {}

  pendingTask(): Task | null {
    return this.pending ? structuredClone(this.pending.task) : null;
  }

  execute(task: Task): Promise<TaskResult> {
    if (this.pending) {
      return Promise.resolve(failure("BLOCKED", "Another lab action is pending."));
    }
    return new Promise<TaskResult>((resolve) => {
      this.pending = { task: structuredClone(task), resolve };
    });
  }

  approve(): TaskResult | null {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    let result: TaskResult;
    try {
      result = this.world.applySuccess(pending.task);
    } catch (error: unknown) {
      result = failure("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
    }
    pending.resolve(result);
    return result;
  }

  reject(code: TaskErrorCode, message: string): TaskResult | null {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    const result = failure(code, message, { retryable: false });
    pending.resolve(result);
    return result;
  }

  abortCurrent(reason = "Lab action interrupted."): boolean {
    return this.reject("INTERRUPTED", reason) !== null;
  }
}
