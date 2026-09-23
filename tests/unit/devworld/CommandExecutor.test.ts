import assert from "node:assert/strict";
import test from "node:test";
import { createArenaBounds } from "../../../src/devworld/ArenaBounds";
import type {
  CommandTransport,
  TransportCommandResult,
} from "../../../src/devworld/controller/MineflayerCommandTransport";
import {
  CommandExecutor,
  type CommandExecutorClock,
} from "../../../src/devworld/execution/CommandExecutor";
import type { WorldPlan } from "../../../src/devworld/WorldPlan";

const affectedBounds = createArenaBounds(
  { x: 0, y: -60, z: 0 },
  { x: 0, y: -60, z: 0 },
);

test("executor preserves plan order and throttles command starts", async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock);
  const executor = new CommandExecutor({
    transport,
    commandsPerSecond: 8,
    maxQueueSize: 10,
    maxPlanCommands: 5,
    clock,
  });

  const first = executor.execute(plan("first", ["a", "b"]));
  const second = executor.execute(plan("second", ["c"]));
  const results = await Promise.all([first, second]);

  assert.deepEqual(
    transport.sent.map(({ command }) => command),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    transport.sent.map(({ sentAt }) => sentAt),
    [0, 125, 250],
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["completed", "completed"],
  );
  assert.equal(executor.snapshot().reservedCommands, 0);
});

test("queue capacity reserves every command atomically", async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock);
  const executor = new CommandExecutor({
    transport,
    commandsPerSecond: 8,
    maxQueueSize: 2,
    maxPlanCommands: 2,
    clock,
  });

  const accepted = executor.execute(plan("accepted", ["a", "b"]));
  await assert.rejects(
    executor.execute(plan("rejected", ["c"])),
    /queue is full/,
  );
  assert.equal((await accepted).status, "completed");
});

test("transport closure interrupts active work and rejects pending plans", async () => {
  const clock = new FakeClock();
  const transport = new ControlledTransport(clock);
  const executor = new CommandExecutor({
    transport,
    commandsPerSecond: 8,
    maxQueueSize: 10,
    maxPlanCommands: 5,
    clock,
  });

  const active = executor.execute(plan("active", ["a", "b"]));
  const pending = executor.execute(plan("pending", ["c"]));
  const pendingOutcome = pending.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
  await nextTurn();
  transport.close("connection ended");
  transport.release();

  assert.equal(await pendingOutcome, "connection ended");
  const activeResult = await active;
  assert.equal(activeResult.status, "interrupted");
  assert.equal(activeResult.commandsSent, 1);
});

class FakeClock implements CommandExecutorClock {
  value = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.value;
  }

  async sleep(durationMs: number): Promise<void> {
    this.sleeps.push(durationMs);
    this.value += durationMs;
  }
}

class FakeTransport implements CommandTransport {
  readonly sent: Array<{ command: string; sentAt: number }> = [];
  protected readonly listeners = new Set<(reason: string) => void>();
  isClosed = false;

  constructor(protected readonly clock: FakeClock) {}

  async send(command: string): Promise<TransportCommandResult> {
    const sentAt = this.clock.now();
    this.sent.push({ command, sentAt });
    return {
      command,
      sentAt,
      responses: [`ok:${command}`],
    };
  }

  subscribeClose(listener: (reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(reason: string): void {
    this.isClosed = true;
    for (const listener of [...this.listeners]) listener(reason);
  }
}

class ControlledTransport extends FakeTransport {
  private resolveSend: ((result: TransportCommandResult) => void) | null =
    null;

  override send(command: string): Promise<TransportCommandResult> {
    const sentAt = this.clock.now();
    this.sent.push({ command, sentAt });
    return new Promise((resolve) => {
      this.resolveSend = resolve;
    });
  }

  release(): void {
    this.resolveSend?.({
      command: this.sent.at(-1)!.command,
      sentAt: this.sent.at(-1)!.sentAt,
      responses: [],
    });
  }
}

function plan(id: string, commands: readonly string[]): WorldPlan {
  return {
    id,
    description: id,
    commands: commands.map((text) => ({
      text,
      estimatedBlocksChanged: 1,
      affectedBounds,
    })),
    estimatedBlocksChanged: commands.length,
    affectedBounds,
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
