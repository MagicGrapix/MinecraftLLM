import { setTimeout as delay } from "node:timers/promises";
import { ACTION_CONFIRMATION } from "../config";

export interface ConfirmationTiming { readonly pollIntervalMs: number; readonly timeoutMs: number }

/** Checks immediately; the deadline bounds observation, never retries the physical action. */
export async function waitForConfirmation(
  check: () => boolean,
  signal: AbortSignal,
  timing: ConfirmationTiming = ACTION_CONFIRMATION,
): Promise<boolean> {
  const deadline = performance.now() + timing.timeoutMs;
  while (true) {
    signal.throwIfAborted();
    if (check()) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(timing.pollIntervalMs, remaining), undefined, { signal });
  }
}
