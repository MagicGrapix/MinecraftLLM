import { setTimeout as delay } from "node:timers/promises";
import { bounded } from "./async";
import type { Observation } from "./types";

/** Detach inputs and await producers before sampling. Does not disconnect the observer. */
export async function settledObservation(options: {
  settle(): Promise<void>;
  snapshot(): Promise<Observation>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<Observation> {
  await options.settle();
  const timeoutMs = options.timeoutMs ?? 3000;
  const deadline = performance.now() + timeoutMs;
  let previous: string | undefined;
  let latest: Observation | undefined;
  while (performance.now() < deadline) {
    latest = await bounded(options.snapshot(), Math.max(1, deadline - performance.now()), "Final observation");
    if (!latest.physicalIdle) throw new Error("Physical execution is not idle after settlement; final observation refused.");
    const unknown = latest.blocks.find(b => b.name === null) || latest.containers?.find(c => c.inventory === null);
    // Ignore continuous physics rounding/yaw; compare all observed blocks, properties and item counts.
    const signature = JSON.stringify({ blocks: latest.blocks, inventory: latest.inventory,
      containers: latest.containers, windowOpen: latest.windowOpen });
    if (!unknown && signature === previous) return latest;
    previous = unknown ? undefined : signature;
    await delay(options.pollMs ?? 100);
  }
  const unknown = latest?.blocks.find(b => b.name === null) ?? latest?.containers?.find(c => c.inventory === null);
  throw new Error(`Final observations did not become known and stable within ${timeoutMs} ms. ${unknown ? `Unavailable: ${JSON.stringify(unknown)}` : "State still changing."}`);
}
