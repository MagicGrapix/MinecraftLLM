import { sleep } from "../../shared/helper";
import type { CommandTransport } from "../controller/MineflayerCommandTransport";
import type { WorldPlan } from "../WorldPlan";
import {
  CommandExecutionStoppedError,
  type CommandExecutionRecord,
  type CommandResult,
} from "./CommandResult";

export interface CommandExecutorClock {
  now(): number;
  sleep(durationMs: number): Promise<void>;
}

export interface CommandExecutorOptions {
  readonly transport: CommandTransport;
  readonly commandsPerSecond: number;
  readonly maxQueueSize: number;
  readonly maxPlanCommands: number;
  readonly clock?: CommandExecutorClock;
}

export interface CommandExecutorSnapshot {
  readonly stopped: boolean;
  readonly activePlanId: string | null;
  readonly pendingPlans: number;
  readonly reservedCommands: number;
}

interface QueueEntry {
  readonly plan: WorldPlan;
  readonly resolve: (result: CommandResult) => void;
  readonly reject: (error: Error) => void;
}

const systemClock: CommandExecutorClock = {
  now: Date.now,
  sleep,
};

export class CommandExecutor {
  private readonly queue: QueueEntry[] = [];
  private readonly clock: CommandExecutorClock;
  private readonly minimumIntervalMs: number;
  private readonly unsubscribeTransport: () => void;
  private active: QueueEntry | null = null;
  private pumping = false;
  private stopped = false;
  private stopReason = "World command executor stopped.";
  private reservedCommands = 0;
  private lastCommandStartedAt: number | null = null;

  constructor(private readonly options: CommandExecutorOptions) {
    if (
      !Number.isFinite(options.commandsPerSecond) ||
      options.commandsPerSecond <= 0
    ) {
      throw new Error("commandsPerSecond must be positive.");
    }
    if (
      !Number.isInteger(options.maxQueueSize) ||
      options.maxQueueSize <= 0 ||
      !Number.isInteger(options.maxPlanCommands) ||
      options.maxPlanCommands <= 0
    ) {
      throw new Error("Executor queue limits must be positive integers.");
    }
    this.clock = options.clock ?? systemClock;
    this.minimumIntervalMs = 1_000 / options.commandsPerSecond;
    this.unsubscribeTransport = options.transport.subscribeClose(
      (reason) => this.stop(reason),
    );
  }

  execute(plan: WorldPlan): Promise<CommandResult> {
    if (this.stopped) {
      return Promise.reject(
        new CommandExecutionStoppedError(this.stopReason),
      );
    }
    if (plan.commands.length > this.options.maxPlanCommands) {
      return Promise.reject(
        new Error(
          `Plan has ${plan.commands.length} commands; maximum is ${this.options.maxPlanCommands}.`,
        ),
      );
    }
    if (
      this.reservedCommands + plan.commands.length >
      this.options.maxQueueSize
    ) {
      return Promise.reject(
        new Error("World command executor queue is full."),
      );
    }

    this.reservedCommands += plan.commands.length;
    const promise = new Promise<CommandResult>((resolve, reject) => {
      this.queue.push({ plan, resolve, reject });
    });
    this.schedulePump();
    return promise;
  }

  snapshot(): CommandExecutorSnapshot {
    return {
      stopped: this.stopped,
      activePlanId: this.active?.plan.id ?? null,
      pendingPlans: this.queue.length,
      reservedCommands: this.reservedCommands,
    };
  }

  stop(reason = "World command executor stopped."): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    const error = new CommandExecutionStoppedError(reason);
    for (const entry of this.queue.splice(0)) {
      this.reservedCommands -= entry.plan.commands.length;
      entry.reject(error);
    }
  }

  dispose(reason = "World command executor disposed."): void {
    this.stop(reason);
    this.unsubscribeTransport();
  }

  async shutdown(
    reason = "World command executor shut down.",
  ): Promise<void> {
    this.stop(reason);
    while (this.pumping) await sleep(0);
    this.unsubscribeTransport();
  }

  private schedulePump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    try {
      while (!this.stopped) {
        const entry = this.queue.shift();
        if (!entry) return;
        this.active = entry;
        const result = await this.executePlan(entry.plan);
        this.reservedCommands -= entry.plan.commands.length;
        this.active = null;
        entry.resolve(result);
      }
    } finally {
      this.pumping = false;
      if (!this.stopped && this.queue.length > 0) this.schedulePump();
    }
  }

  private async executePlan(plan: WorldPlan): Promise<CommandResult> {
    const startedAt = this.clock.now();
    const records: CommandExecutionRecord[] = [];
    let status: CommandResult["status"] = "completed";
    let errorMessage: string | undefined;

    for (const command of plan.commands) {
      if (this.stopped) {
        status = "interrupted";
        errorMessage = this.stopReason;
        break;
      }
      await this.throttle();
      if (this.stopped) {
        status = "interrupted";
        errorMessage = this.stopReason;
        break;
      }

      const sentAt = this.clock.now();
      this.lastCommandStartedAt = sentAt;
      try {
        const response = await this.options.transport.send(command.text);
        records.push({
          command: command.text,
          sentAt: response.sentAt,
          responses: [...response.responses],
          ...(response.error ? { error: response.error } : {}),
        });
        if (response.error) {
          status = "failed";
          errorMessage = response.error;
          break;
        }
      } catch (error: unknown) {
        errorMessage =
          error instanceof Error ? error.message : String(error);
        records.push({
          command: command.text,
          sentAt,
          responses: [],
          error: errorMessage,
        });
        status = this.stopped ? "interrupted" : "failed";
        break;
      }
    }

    if (this.stopped && status === "completed") {
      status = "interrupted";
      errorMessage = this.stopReason;
    }
    return {
      planId: plan.id,
      description: plan.description,
      status,
      startedAt,
      finishedAt: this.clock.now(),
      commandsSent: records.length,
      records,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }

  private async throttle(): Promise<void> {
    if (this.lastCommandStartedAt === null) return;
    const elapsed = this.clock.now() - this.lastCommandStartedAt;
    const remaining = this.minimumIntervalMs - elapsed;
    if (remaining > 0) await this.clock.sleep(remaining);
  }
}
