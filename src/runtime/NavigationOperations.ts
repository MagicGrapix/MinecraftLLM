import { setImmediate as yieldToEvents } from "node:timers/promises";
import type { Bot } from "mineflayer";
import type {} from "mineflayer-pathfinder";

const methods = ["equip", "dig", "placeBlock", "activateBlock"] as const;
type Method = typeof methods[number];
type Operation = (...args: unknown[]) => Promise<unknown>;

/**
 * Scoped adapter for pathfinder 2.4.x's detached equip -> dig/place continuations.
 * Executor guarantees exclusive ownership while these methods are wrapped.
 */
export class NavigationOperations {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly restores: (() => void)[] = [];
  private finishPromise: Promise<void> | null = null;
  private readonly cleanupErrors: unknown[] = [];

  constructor(private readonly bot: Bot, private readonly signal: AbortSignal,
    register: (operation: Promise<unknown>) => void) {
    const target = bot as unknown as Record<Method, Operation>;
    for (const name of methods) {
      const original = target[name];
      if (typeof original !== "function") continue;
      const guarded: Operation = (...args) => {
        const operation = Promise.resolve().then(async () => {
          this.assertOpen();
          const result = await original.apply(bot, args);
          this.assertOpen();
          return result;
        });
        this.pending.add(operation);
        register(operation);
        void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
        return operation;
      };
      target[name] = guarded;
      this.restores.push(() => { if (target[name] === guarded) target[name] = original; });
    }
    signal.addEventListener("abort", this.cancel, { once: true });
    bot.on("end", this.cancel);
    if (signal.aborted) this.cancel();
  }

  private assertOpen(): void {
    if (this.closed || this.signal.aborted) throw new DOMException("Navigation operation cancelled.", "AbortError");
  }

  private readonly cancel = (): void => {
    if (this.closed) return;
    this.closed = true;
    // Abort event handlers must not throw before pending operations are drained.
    this.attemptCleanup(() => this.bot.stopDigging?.());
    this.attemptCleanup(() => this.bot.clearControlStates?.());
  };

  private attemptCleanup(operation: () => void): void {
    try { operation(); } catch (error) { this.cleanupErrors.push(error); }
  }

  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = this.drain();
    return this.finishPromise;
  }

  private async drain(): Promise<void> {
    this.cancel();
    try {
      this.attemptCleanup(() => {
        if (this.bot.pathfinder.goal !== null) this.bot.pathfinder.setGoal(null);
      });
      // Even a failed reset must not release ownership of pending physical work.
      do {
        await Promise.allSettled([...this.pending]);
        await yieldToEvents();
      } while (this.pending.size > 0);
    } finally {
      this.signal.removeEventListener("abort", this.cancel);
      this.bot.removeListener("end", this.cancel);
      this.attemptCleanup(() => this.bot.clearControlStates?.());
      for (const restore of this.restores) restore();
    }
    if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, `Navigation cleanup failed: ${this.cleanupErrors.map(String).join("; ")}`);
  }
}
