import { setTimeout as delay } from "node:timers/promises";
import { message } from "./async";
import type { Observation, Scenario, TrialAgent, TrialResult } from "./types";

interface TrialOptions {
  scenario: Scenario;
  agent: TrialAgent;
  initial: Observation;
  /** Adds controller-only observations when needed; never executes agent actions. */
  snapshot?: () => Promise<Observation>;
  timeoutMs: number;
  acceptanceTimeoutMs: number;
  pollMs: number;
  sendChat(text: string): Promise<void>;
  record(event: string, data: unknown): void;
  signal?: AbortSignal;
  inArena(position: Observation["position"]): boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/** Pure lifecycle driver; controller reset/process ownership stay outside this loop. */
export async function runTrial(options: TrialOptions): Promise<TrialResult> {
  const { scenario, agent, initial, timeoutMs, signal } = options;
  // Keep the same targets even if the bot turns or moves during the request.
  const positions = initial.blocks.map((block) => block.position);
  const snapshot = options.snapshot ?? (() => agent.snapshot(positions));
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? ((ms) => delay(ms, undefined, { signal }));
  const result: TrialResult = {
    scenario: scenario.id, status: "error", timeoutMs, startedAt: new Date().toISOString(),
    durationMs: 0, goalReachedAtMs: null, initial,
  };
  try {
    signal?.throwIfAborted();
    await agent.arm(scenario.prompt);
    await options.sendChat(scenario.prompt);
    const sent = now();
    while (agent.acceptedAt === null) {
      signal?.throwIfAborted();
      if (agent.failure) throw new Error(agent.failure);
      if (now() - sent >= options.acceptanceTimeoutMs) throw new Error("Chat request was not accepted.");
      await wait(options.pollMs);
    }
    const start = agent.acceptedAt;
    let observationId = 0;
    let stableContainerState: string | null = null;
    options.record("trial.accepted", { scenario: scenario.id, timeoutMs });
    while (true) {
      signal?.throwIfAborted();
      if (agent.failure) throw new Error(agent.failure);
      const remaining = timeoutMs - (now() - start);
      if (remaining <= 0) { result.durationMs = now() - start; result.status = "timeout"; break; }
      let timer: NodeJS.Timeout | undefined;
      let observation: Observation | null;
      // A snapshot requested before completion may arrive after it, but is stale.
      const finishedBeforeSnapshot = agent.finished;
      const requestedAtMs = now() - start;
      try {
        observation = await Promise.race([snapshot(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); })]);
      } finally { clearTimeout(timer); }
      if (observation === null) { result.durationMs = now() - start; result.status = "timeout"; break; }
      result.final = observation;
      result.durationMs = now() - start;
      result.criterion = scenario.verify(initial, observation);
      options.record("trial.observation", { observationId: ++observationId, requestedAtMs, receivedAtMs: result.durationMs,
        afterWorkflowFinish: finishedBeforeSnapshot !== null, elapsedMs: result.durationMs, ...observation, criterion: result.criterion });
      const unknownContainer = observation.containers?.find((container) => container.inventory === null);
      if (unknownContainer) throw new Error(`Container observation unavailable: ${JSON.stringify(unknownContainer)}`);
      if (!options.inArena(observation.position)) throw new Error("Bot left the testing arena.");
      if (result.criterion.passed && result.goalReachedAtMs === null) result.goalReachedAtMs = result.durationMs;
      // A late observation/completion cannot turn an expired attempt into a pass.
      if (result.durationMs >= timeoutMs) { result.status = "timeout"; break; }
      if (finishedBeforeSnapshot && agent.finished === finishedBeforeSnapshot && observation.physicalIdle) {
        if (finishedBeforeSnapshot.error) throw new Error(finishedBeforeSnapshot.error);
        // Cross-client observations are not atomic. Require two matching post-finish
        // inventory/container samples before judging a transfer.
        const signature = JSON.stringify({ inventory: Object.entries(observation.inventory).sort(),
          containers: observation.containers?.map((container) => ({ ...container, inventory: Object.entries(container.inventory!).sort() })),
          blocks: observation.blocks, windowOpen: observation.windowOpen });
        if (!observation.containers?.length || signature === stableContainerState) {
          result.status = result.criterion.passed ? "passed" : "failed";
          break;
        }
        stableContainerState = signature;
      } else stableContainerState = null;
      if (observation.mode === "stopped") throw new Error("Trial interrupted before completion.");
      await wait(Math.min(options.pollMs, timeoutMs - result.durationMs));
    }
  } catch (error) {
    result.status = "error";
    result.error = message(error);
    if (agent.acceptedAt !== null) result.durationMs = now() - agent.acceptedAt;
  }
  options.record("trial.finished", result);
  return result;
}
