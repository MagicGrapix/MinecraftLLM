import type { ExecutionContext } from "../capabilities/Capability";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { DEFAULT_TASK_TIMEOUT_MS } from "../config";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { errorMessage, runWithCancellation, sleep } from "../shared/helper";
import type { WorldQueries } from "../world/WorldQueries";
import type { Task } from "./Task";
import { failure, type TaskResult } from "./TaskResult";

export interface ExecutorOptions {
  registry: CapabilityRegistry;
  runtime: MinecraftRuntime;
  world: WorldQueries;
  defaultTimeoutMs?: number;
  cancellationGraceMs?: number;
}

type TaskCancellation =
  | { kind: "timeout"; reason: string }
  | { kind: "interrupted"; reason: string };

interface CurrentExecution {
  task: Task;
  controller: AbortController;
  cancellation: TaskCancellation | null;
}

export class Executor {
  private readonly registry: CapabilityRegistry;
  private readonly runtime: MinecraftRuntime;
  private readonly world: WorldQueries;
  private readonly defaultTimeoutMs: number;
  private readonly cancellationGraceMs: number;

  private currentExecution: CurrentExecution | null = null;

  constructor(options: ExecutorOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.world = options.world;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.cancellationGraceMs = options.cancellationGraceMs ?? 1_000;
    if (!Number.isFinite(this.cancellationGraceMs) || this.cancellationGraceMs < 0) {
      throw new Error("Cancellation grace must be a non-negative duration.");
    }
  }

  get currentTask(): Task | null {
    return this.currentExecution?.task ?? null;
  }

  /** Cancellation may return before Mineflayer settles. Call after stopping producers. */
  async waitForIdle(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid idle timeout.");
    const deadline = performance.now() + timeoutMs;
    while (this.currentExecution) {
      if (performance.now() >= deadline) throw new Error("Physical action did not settle before the idle deadline.");
      await sleep(Math.min(20, Math.max(1, deadline - performance.now())));
    }
  }

  abortCurrent(reason = "Task interrupted."): boolean {
    const execution = this.currentExecution;
    if (!execution || execution.cancellation) return false;

    execution.cancellation = { kind: "interrupted", reason };
    execution.controller.abort(execution.cancellation);
    return true;
  }

  async execute(task: Task): Promise<TaskResult> {
    const active = this.currentExecution;
    if (active) {
      return failure(
        "BLOCKED",
        `Task "${task.id}" cannot start while "${active.task.id}" is active.`,
        {
          retryable: true,
          facts: {
            currentTaskId: active.task.id,
            requestedTaskId: task.id,
          },
        },
      );
    }

    const capability = this.registry.get(task.capability);
    if (!capability) {
      return failure(
        "INVALID_ARGUMENT",
        `Unknown capability "${task.capability}".`,
        { facts: { capability: task.capability } },
      );
    }

    const timeoutMs = task.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return failure("INVALID_ARGUMENT", "Task timeout must be positive.", {
        facts: { timeoutMs },
      });
    }

    const parsed = capability.inputSchema.safeParse(task.input);
    if (!parsed.success) {
      return failure(
        "INVALID_ARGUMENT",
        `Invalid input for capability "${task.capability}".`,
        {
          facts: {
            issues: parsed.error.issues,
          },
        },
      );
    }

    const execution: CurrentExecution = {
      task,
      controller: new AbortController(),
      cancellation: null,
    };
    this.currentExecution = execution;
    const cancellationBarriers = new Set<Promise<void>>();

    const context: ExecutionContext = {
      runtime: this.runtime,
      world: this.world,
      signal: execution.controller.signal,
      deferCancellationUntil: (operation) => {
        const barrier = operation.then(
          () => undefined,
          () => undefined,
        );
        cancellationBarriers.add(barrier);
        void barrier.finally(() => cancellationBarriers.delete(barrier));
      },
    };

    let settled = true;
    let settlement: Promise<void> = Promise.resolve();
    try {
      const operation = (async () => capability.execute(parsed.data, context))();
      settled = false;
      // A timeout cancels our wait, not the underlying Minecraft promise.
      // Keep the physical lock until the capability AND its registered work settle.
      settlement = operation.then(() => undefined, () => undefined)
        .then(() => waitForCancellationBarriers(cancellationBarriers))
        .then(() => {
          settled = true;
          if (this.currentExecution === execution) this.currentExecution = null;
        });
      const result = await runWithCancellation(
        operation.then(async (result) => { await settlement; return result; }),
        execution.controller.signal,
        timeoutMs,
        () => {
          this.cancelForTimeout(execution, timeoutMs);
        },
      );
      return result;
    } catch (error: unknown) {
      if (execution.cancellation?.kind === "timeout") {
        await waitForSettlement(settlement, this.cancellationGraceMs);
        return failure("TIMEOUT", execution.cancellation.reason, {
          retryable: true,
          facts: { taskId: task.id, timeoutMs, stillSettling: !settled },
        });
      }

      if (execution.cancellation?.kind === "interrupted") {
        await waitForSettlement(settlement, this.cancellationGraceMs);
        return failure("INTERRUPTED", execution.cancellation.reason, {
          retryable: true,
          facts: { taskId: task.id, stillSettling: !settled },
        });
      }

      return failure("INTERNAL_ERROR", errorMessage(error), {
        retryable: false,
        facts: { taskId: task.id, capability: task.capability },
      });
    } finally {
      if (settled && this.currentExecution === execution) {
        this.currentExecution = null;
      }
    }
  }

  private cancelForTimeout(
    execution: CurrentExecution,
    timeoutMs: number,
  ): void {
    if (execution.cancellation) return;

    execution.cancellation = {
      kind: "timeout",
      reason: `Task timed out after ${timeoutMs} ms.`,
    };
    execution.controller.abort(execution.cancellation);
  }
}

async function waitForSettlement(operation: Promise<void>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCancellationBarriers(
  barriers: ReadonlySet<Promise<void>>,
): Promise<void> {
  while (barriers.size > 0) {
    await Promise.all([...barriers]);
  }
}
