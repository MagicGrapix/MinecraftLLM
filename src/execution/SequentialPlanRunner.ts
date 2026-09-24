import type { Task, TaskSpec } from "./Task";
import { TaskFactory } from "./TaskFactory";
import type { TaskResult } from "./TaskResult";
import type { Executor } from "./Executor";

export type SequentialRunnerEvent =
  | { readonly type: "task_started"; readonly task: Task }
  | {
      readonly type: "task_finished";
      readonly task: Task;
      readonly result: TaskResult;
    };

export interface SequentialTaskOutcome {
  readonly task: Task;
  readonly result: TaskResult;
}

export class SequentialPlanRunner {
  private pending: TaskSpec[] = [];
  private active: Task | null = null;
  private activeCompletion: Promise<SequentialTaskOutcome> | null = null;
  private readonly listeners = new Set<
    (event: SequentialRunnerEvent) => void
  >();
  private shutdownRequested = false;

  constructor(
    private readonly executor: Executor,
    private readonly taskFactory = new TaskFactory(),
  ) {}

  get currentTask(): Task | null {
    return this.active ? structuredClone(this.active) : null;
  }

  get isExecuting(): boolean {
    return this.active !== null;
  }

  setPlan(tasks: readonly TaskSpec[]): void {
    this.assertMutable();
    this.pending = cloneSpecs(tasks);
  }

  replaceRemaining(tasks: readonly TaskSpec[]): void {
    this.setPlan(tasks);
  }

  remaining(): readonly TaskSpec[] {
    return cloneSpecs(this.pending);
  }

  clear(): void {
    this.assertMutable();
    this.pending = [];
  }

  subscribe(
    listener: (event: SequentialRunnerEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  executeNext(): Promise<SequentialTaskOutcome | null> {
    if (this.shutdownRequested) {
      return Promise.reject(
        new Error("SequentialPlanRunner has been shut down."),
      );
    }
    if (this.activeCompletion) {
      return Promise.reject(
        new Error("A sequential task is already executing."),
      );
    }
    const spec = this.pending.shift();
    if (!spec) return Promise.resolve(null);

    const task = this.taskFactory.create(spec);
    this.active = task;
    this.emit({ type: "task_started", task: structuredClone(task) });
    const completion = this.execute(task);
    this.activeCompletion = completion;
    return completion;
  }

  abortCurrent(reason = "Task interrupted."): boolean {
    return this.executor.abortCurrent(reason);
  }

  async shutdown(reason = "Sequential runner stopped."): Promise<void> {
    if (this.shutdownRequested) {
      await this.activeCompletion?.catch(() => undefined);
      return;
    }
    this.shutdownRequested = true;
    this.pending = [];
    this.executor.abortCurrent(reason);
    await this.activeCompletion?.catch(() => undefined);
    this.listeners.clear();
  }

  private async execute(task: Task): Promise<SequentialTaskOutcome> {
    try {
      const result = await this.executor.execute(task);
      const outcome = {
        task: structuredClone(task),
        result: structuredClone(result),
      };
      this.emit({
        type: "task_finished",
        task: outcome.task,
        result: outcome.result,
      });
      return outcome;
    } finally {
      this.active = null;
      this.activeCompletion = null;
    }
  }

  private assertMutable(): void {
    if (this.shutdownRequested) {
      throw new Error("SequentialPlanRunner has been shut down.");
    }
  }

  private emit(event: SequentialRunnerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        console.error("Sequential runner listener failed:", error);
      }
    }
  }
}

function cloneSpecs(specs: readonly TaskSpec[]): TaskSpec[] {
  return specs.map((spec) => ({
    capability: spec.capability,
    input: structuredClone(spec.input),
    ...(spec.timeoutMs === undefined
      ? {}
      : { timeoutMs: spec.timeoutMs }),
  }));
}
