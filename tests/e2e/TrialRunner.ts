import { setTimeout as delay } from "node:timers/promises";
import { message } from "./async";
import type { Observation, Scenario, TrialAgent, TrialResult } from "./types";

interface TrialOptions {
  scenario: Scenario;
  agent: TrialAgent;
  initial: Observation;
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
    options.record("trial.accepted", { scenario: scenario.id, timeoutMs });
    while (true) {
      signal?.throwIfAborted();
      if (agent.failure) throw new Error(agent.failure);
      const remaining = timeoutMs - (now() - start);
      if (remaining <= 0) { result.durationMs = now() - start; result.status = "timeout"; break; }
      let timer: NodeJS.Timeout | undefined;
      let observation: Observation | null;
      try {
        observation = await Promise.race([agent.snapshot(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); })]);
      } finally { clearTimeout(timer); }
      if (observation === null) { result.durationMs = now() - start; result.status = "timeout"; break; }
      result.final = observation;
      result.durationMs = now() - start;
      result.criterion = scenario.verify(initial, observation);
      options.record("trial.observation", { elapsedMs: result.durationMs, ...observation, criterion: result.criterion });
      if (!options.inArena(observation.position)) throw new Error("Bot left the testing arena.");
      if (result.criterion.passed && result.goalReachedAtMs === null) result.goalReachedAtMs = result.durationMs;
      // A late observation/completion cannot turn an expired attempt into a pass.
      if (result.durationMs >= timeoutMs) { result.status = "timeout"; break; }
      if (agent.finished && observation.physicalIdle) {
        if (agent.finished.error) throw new Error(agent.finished.error);
        result.status = result.criterion.passed ? "passed" : "failed";
        break;
      }
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
