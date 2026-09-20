import type { Executor } from "./Executor";
import { ExecutionQueue } from "./ExecutionQueue";
import type { Task, TaskSpec } from "./Task";
import { TaskFactory } from "./TaskFactory";
import { failure, type TaskResult } from "./TaskResult";

export type ExecutionMode = "paused" | "draining" | "stepping";

export interface MutationOptions {
  expectedRevision?: number;
}

export interface ExecutionSnapshot {
  readonly revision: number;
  readonly mode: ExecutionMode;
  readonly current: {
    readonly task: Task;
    readonly startedAt: number;
  } | null;
  readonly pending: readonly Task[];
  readonly shutdown: boolean;
}

export type ExecutionEvent =
  | { type: "mode_changed"; snapshot: ExecutionSnapshot }
  | {
      type: "queue_changed";
      reason: string;
      snapshot: ExecutionSnapshot;
    }
  | {
      type: "task_started";
      task: Task;
      snapshot: ExecutionSnapshot;
    }
  | {
      type: "task_finished";
      task: Task;
      result: TaskResult;
      snapshot: ExecutionSnapshot;
    }
  | { type: "queue_idle"; snapshot: ExecutionSnapshot }
  | { type: "shutdown"; snapshot: ExecutionSnapshot };

export type ExecutionEventListener = (event: ExecutionEvent) => void;

export type ControlErrorCode =
  | "REVISION_CONFLICT"
  | "INVALID_STATE"
  | "SHUTDOWN"
  | "TASK_NOT_FOUND"
  | "INVALID_TASK_SPEC";

export interface ControlError {
  readonly code: ControlErrorCode;
  readonly message: string;
  readonly facts?: Record<string, unknown>;
}

export type ControlResult =
  | {
      readonly ok: true;
      readonly snapshot: ExecutionSnapshot;
      readonly taskIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: ControlError;
      readonly snapshot: ExecutionSnapshot;
    };

export interface ExecutionControllerOptions {
  executor: Executor;
  queue?: ExecutionQueue;
  taskFactory?: TaskFactory;
}

interface ActiveTask {
  task: Task;
  startedAt: number;
}

export class ExecutionController {
  private readonly executor: Executor;
  private readonly queue: ExecutionQueue;
  private readonly taskFactory: TaskFactory;
  private readonly listeners = new Set<ExecutionEventListener>();

  private mode: ExecutionMode = "paused";
  private revision = 0;
  private active: ActiveTask | null = null;
  private activeCompletion: Promise<TaskResult> | null = null;
  private pumpScheduled = false;
  private idleNotified = false;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: ExecutionControllerOptions) {
    this.executor = options.executor;
    this.queue = options.queue ?? new ExecutionQueue();
    this.taskFactory = options.taskFactory ?? new TaskFactory();
  }

  enqueue(
    spec: TaskSpec,
    options: MutationOptions = {},
  ): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    const tasks = this.materialize([spec]);
    if (!tasks.ok) return tasks.result;

    this.queue.enqueue(tasks.tasks[0]!);
    return this.afterQueueMutation("enqueue", tasks.tasks);
  }

  enqueueMany(
    specs: readonly TaskSpec[],
    options: MutationOptions = {},
  ): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    const tasks = this.materialize(specs);
    if (!tasks.ok) return tasks.result;
    if (tasks.tasks.length === 0) return this.success();

    this.queue.enqueueMany(tasks.tasks);
    return this.afterQueueMutation("enqueue_many", tasks.tasks);
  }

  prepend(
    spec: TaskSpec,
    options: MutationOptions = {},
  ): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    const tasks = this.materialize([spec]);
    if (!tasks.ok) return tasks.result;

    this.queue.prepend(tasks.tasks[0]!);
    return this.afterQueueMutation("prepend", tasks.tasks);
  }

  removePending(
    taskId: string,
    options: MutationOptions = {},
  ): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    const removed = this.queue.remove(taskId);
    if (!removed) {
      return this.controlFailure(
        "TASK_NOT_FOUND",
        `Pending task "${taskId}" does not exist.`,
        { taskId },
      );
    }

    const snapshot = this.changed();
    this.emit({ type: "queue_changed", reason: "remove", snapshot });
    this.notifyIdleIfNeeded();
    return this.success(snapshot, [taskId]);
  }

  replacePending(
    specs: readonly TaskSpec[],
    options: MutationOptions = {},
  ): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    const tasks = this.materialize(specs);
    if (!tasks.ok) return tasks.result;

    this.queue.replace(tasks.tasks);
    this.idleNotified = false;
    const snapshot = this.changed();
    this.emit({ type: "queue_changed", reason: "replace", snapshot });
    this.notifyIdleIfNeeded();
    this.schedulePump();
    return this.success(
      snapshot,
      tasks.tasks.map((task) => task.id),
    );
  }

  clearPending(options: MutationOptions = {}): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    const removedIds = this.queue.toArray().map((task) => task.id);
    this.queue.clear();
    const snapshot = this.changed();
    this.emit({ type: "queue_changed", reason: "clear", snapshot });
    this.notifyIdleIfNeeded();
    return this.success(snapshot, removedIds);
  }

  resume(options: MutationOptions = {}): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    let snapshot = this.snapshot();
    if (this.mode !== "draining") {
      this.mode = "draining";
      snapshot = this.changed();
      this.emit({ type: "mode_changed", snapshot });
    }

    this.schedulePump();
    return this.success(snapshot);
  }

  pause(options: MutationOptions = {}): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    if (this.mode === "paused") return this.success();

    this.mode = "paused";
    const snapshot = this.changed();
    this.emit({ type: "mode_changed", snapshot });
    return this.success(snapshot);
  }

  step(options: MutationOptions = {}): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    if (this.mode !== "paused" || this.active) {
      return this.controlFailure(
        "INVALID_STATE",
        "step() requires a paused controller with no active task.",
        { mode: this.mode, currentTaskId: this.active?.task.id ?? null },
      );
    }

    if (this.queue.size === 0) {
      this.notifyIdleIfNeeded();
      return this.success();
    }

    this.mode = "stepping";
    const snapshot = this.changed();
    this.emit({ type: "mode_changed", snapshot });
    this.schedulePump();
    return this.success(snapshot);
  }

  abortCurrent(
    reason = "Task interrupted by controller.",
    options: MutationOptions = {},
  ): ControlResult {
    const rejected = this.rejectMutation(options);
    if (rejected) return rejected;

    if (this.mode !== "paused") {
      this.mode = "paused";
      const modeSnapshot = this.changed();
      this.emit({ type: "mode_changed", snapshot: modeSnapshot });
    }

    const taskId = this.active?.task.id;
    if (!taskId) return this.success();

    if (this.executor.abortCurrent(reason)) {
      const snapshot = this.changed();
      return this.success(snapshot, [taskId]);
    }

    return this.success();
  }

  snapshot(): ExecutionSnapshot {
    return {
      revision: this.revision,
      mode: this.mode,
      current: this.active
        ? {
            task: cloneTask(this.active.task),
            startedAt: this.active.startedAt,
          }
        : null,
      pending: this.queue.toArray().map(cloneTask),
      shutdown: this.shutdownRequested,
    };
  }

  subscribe(listener: ExecutionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  shutdown(reason = "Execution controller shut down."): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownRequested = true;
    this.mode = "paused";
    this.queue.clear();
    this.idleNotified = false;
    this.changed();
    this.executor.abortCurrent(reason);

    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    if (this.activeCompletion) {
      await this.activeCompletion;
    }

    const snapshot = this.changed();
    this.emit({ type: "shutdown", snapshot });
    this.listeners.clear();
  }

  private schedulePump(): void {
    if (
      this.pumpScheduled ||
      this.shutdownRequested ||
      this.mode === "paused"
    ) {
      return;
    }

    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (
      this.shutdownRequested ||
      this.mode === "paused" ||
      this.active
    ) {
      return;
    }

    const task = this.queue.dequeue();
    if (!task) {
      this.notifyIdleIfNeeded();
      return;
    }

    this.idleNotified = false;
    this.active = { task, startedAt: Date.now() };
    const startedSnapshot = this.changed();
    this.emit({
      type: "task_started",
      task: cloneTask(task),
      snapshot: startedSnapshot,
    });

    const completion = this.executor.execute(task);
    this.activeCompletion = completion;
    void completion.then(
      (result) => this.finishTask(task, result),
      (error: unknown) =>
        this.finishTask(
          task,
          failure(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          ),
        ),
    );
  }

  private finishTask(task: Task, result: TaskResult): void {
    if (this.active?.task.id !== task.id) return;

    this.active = null;
    this.activeCompletion = null;
    const finishedSnapshot = this.changed();
    this.emit({
      type: "task_finished",
      task: cloneTask(task),
      result,
      snapshot: finishedSnapshot,
    });

    if (this.mode === "stepping") {
      this.mode = "paused";
      const modeSnapshot = this.changed();
      this.emit({ type: "mode_changed", snapshot: modeSnapshot });
    }

    if (this.shutdownRequested) return;
    if (this.mode === "draining") {
      this.schedulePump();
    } else {
      this.notifyIdleIfNeeded();
    }
  }

  private afterQueueMutation(
    reason: string,
    tasks: readonly Task[],
  ): ControlResult {
    this.idleNotified = false;
    const snapshot = this.changed();
    this.emit({ type: "queue_changed", reason, snapshot });
    this.schedulePump();
    return this.success(
      snapshot,
      tasks.map((task) => task.id),
    );
  }

  private notifyIdleIfNeeded(): void {
    if (this.active || this.queue.size > 0 || this.idleNotified) return;

    this.idleNotified = true;
    this.emit({ type: "queue_idle", snapshot: this.snapshot() });
  }

  private rejectMutation(options: MutationOptions): ControlResult | null {
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== this.revision
    ) {
      return this.controlFailure(
        "REVISION_CONFLICT",
        `Expected revision ${options.expectedRevision}, current revision is ${this.revision}.`,
        {
          expectedRevision: options.expectedRevision,
          actualRevision: this.revision,
        },
      );
    }

    if (this.shutdownRequested) {
      return this.controlFailure(
        "SHUTDOWN",
        "Execution controller is shut down.",
      );
    }

    return null;
  }

  private materialize(
    specs: readonly TaskSpec[],
  ):
    | { ok: true; tasks: Task[] }
    | { ok: false; result: ControlResult } {
    try {
      return { ok: true, tasks: this.taskFactory.createMany(specs) };
    } catch (error: unknown) {
      return {
        ok: false,
        result: this.controlFailure(
          "INVALID_TASK_SPEC",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }

  private changed(): ExecutionSnapshot {
    this.revision += 1;
    return this.snapshot();
  }

  private success(
    snapshot = this.snapshot(),
    taskIds: readonly string[] = [],
  ): ControlResult {
    return { ok: true, snapshot, taskIds: [...taskIds] };
  }

  private controlFailure(
    code: ControlErrorCode,
    message: string,
    facts?: Record<string, unknown>,
  ): ControlResult {
    return {
      ok: false,
      error: facts ? { code, message, facts } : { code, message },
      snapshot: this.snapshot(),
    };
  }

  private emit(event: ExecutionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        console.error("Execution event listener failed:", error);
      }
    }
  }
}

function cloneTask(task: Task): Task {
  return {
    id: task.id,
    capability: task.capability,
    input: structuredClone(task.input),
    createdAt: task.createdAt,
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
  };
}
