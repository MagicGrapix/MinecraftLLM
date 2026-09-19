import type { ExecutionContext } from "../capabilities/Capability";
import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { DEFAULT_TASK_TIMEOUT_MS } from "../config";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { errorMessage, runWithCancellation } from "../shared/helper";
import type { WorldQueries } from "../world/WorldQueries";
import type { Task } from "./Task";
import { failure, type TaskResult } from "./TaskResult";

export interface ExecutorOptions {
  registry: CapabilityRegistry;
  runtime: MinecraftRuntime;
  world: WorldQueries;
  defaultTimeoutMs?: number;
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

  private currentExecution: CurrentExecution | null = null;

  constructor(options: ExecutorOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.world = options.world;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  }

  get currentTask(): Task | null {
    return this.currentExecution?.task ?? null;
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

    const context: ExecutionContext = {
      runtime: this.runtime,
      world: this.world,
      signal: execution.controller.signal,
    };

    try {
      return await runWithCancellation(
        capability.execute(parsed.data, context),
        execution.controller.signal,
        timeoutMs,
        () => {
          this.cancelForTimeout(execution, timeoutMs);
        },
      );
    } catch (error: unknown) {
      if (execution.cancellation?.kind === "timeout") {
        return failure("TIMEOUT", execution.cancellation.reason, {
          retryable: true,
          facts: { taskId: task.id, timeoutMs },
        });
      }

      if (execution.cancellation?.kind === "interrupted") {
        return failure("INTERRUPTED", execution.cancellation.reason, {
          retryable: true,
          facts: { taskId: task.id },
        });
      }

      return failure("INTERNAL_ERROR", errorMessage(error), {
        retryable: false,
        facts: { taskId: task.id, capability: task.capability },
      });
    } finally {
      if (this.currentExecution === execution) {
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
