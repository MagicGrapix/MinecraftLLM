import assert from "node:assert/strict";
import test from "node:test";
import { runTrial } from "../../e2e/TrialRunner";
import { scenarios } from "../../e2e/scenarios";
import type { Observation, TrialAgent } from "../../e2e/types";
import { observation } from "../../support/ScenarioObservations";

function harness() {
  let time = 0;
  let state = observation({ mode: "thinking" });
  const events: string[] = [];
  const agent: TrialAgent = {
    acceptedAt: null, finished: null, failure: null,
    arm: async () => { events.push("armed"); },
    snapshot: async () => state,
  };
  return {
    agent, events,
    setState: (next: typeof state) => { state = next; },
    advance: (ms: number) => { time += ms; },
    run: (step: (ms: number) => void = () => undefined, accept = true, signal?: AbortSignal, finalize?: () => Promise<Observation>) => runTrial({
      scenario: scenarios[1]!, agent, initial: observation(), timeoutMs: 500, acceptanceTimeoutMs: 200, pollMs: 50,
      now: () => time, wait: async (ms) => { time += ms; step(time); },
      sendChat: async () => { events.push("chat"); if (accept) agent.acceptedAt = time; },
      record: (name) => events.push(name), inArena: () => true, signal, finalize,
    }),
  };
}

test("trial waits for chat acceptance and both physical success and agent completion", async () => {
  const h = harness();
  const result = await h.run((time) => {
    if (time >= 50) h.setState(observation({ inventory: { oak_log: 2 }, mode: "thinking" }));
    if (time >= 150) h.agent.finished = { at: time };
  });
  assert.equal(result.status, "passed");
  assert.equal(result.goalReachedAtMs, 50);
  assert.equal(result.durationMs, 150);
  assert.deepEqual(h.events.slice(0, 3), ["armed", "chat", "trial.accepted"]);
});

test("collecting resources but looping is a timeout, not a pass", async () => {
  const h = harness();
  h.setState(observation({ inventory: { oak_log: 2 }, mode: "thinking" }));
  const result = await h.run();
  assert.equal(result.status, "timeout");
  assert.equal(result.criterion?.passed, true);
  assert.equal(result.goalReachedAtMs, 0);
});

test("a claim of completion without inventory gain fails", async () => {
  const h = harness(); h.agent.finished = { at: 0 };
  const result = await h.run();
  assert.equal(result.status, "failed");
  assert.equal(result.goalReachedAtMs, null);
});

test("final independent observation can reject a provisional pass and separates verification duration", async () => {
  const h = harness(); h.agent.finished = { at: 0 };
  h.setState(observation({ inventory: { oak_log: 2 } }));
  const result = await h.run(undefined, true, undefined, async () => { h.advance(100); return observation(); });
  assert.equal(result.status, "failed");
  assert.equal(result.finalAfterSettlement, true);
  assert.equal(result.durationMs, 0);
  assert.equal(result.finalVerificationMs, 100);
  assert.ok(h.events.indexOf("trial.final_observation") < h.events.indexOf("trial.finished"));
});

test("late final success cannot promote a timeout or earlier failed criterion", async () => {
  for (const finished of [false, true]) {
    const h = harness(); if (finished) h.agent.finished = { at: 0 };
    const result = await h.run(undefined, true, undefined, async () => observation({ inventory: { oak_log: 2 } }));
    assert.equal(result.status, finished ? "failed" : "timeout");
    assert.equal(result.finalAfterSettlement, true);
    assert.equal(result.criterion?.passed, true);
  }
});

test("settlement failure invalidates a pass but preserves timeout classification", async () => {
  for (const finished of [false, true]) {
    const h = harness(); if (finished) h.agent.finished = { at: 0 };
    h.setState(observation({ inventory: { oak_log: 2 } }));
    const result = await h.run(undefined, true, undefined, async () => { throw new Error("unavailable cell"); });
    assert.equal(result.status, finished ? "error" : "timeout");
    assert.equal(result.finalAfterSettlement, false);
    assert.match(result.error!, /Final verification: unavailable cell/);
  }
});

test("a finished workflow cannot pass while physical work is still settling", async () => {
  const h = harness(); h.agent.finished = { at: 0 };
  h.setState(observation({ inventory: { oak_log: 2 }, physicalIdle: false }));
  assert.equal((await h.run()).status, "timeout");
});

test("missing acceptance, worker failure and cancellation are explicit errors", async () => {
  const h = harness();
  assert.match((await h.run(undefined, false)).error!, /not accepted/);
  const failed = harness(); failed.agent.failure = "connection lost";
  assert.match((await failed.run()).error!, /connection lost/);
  const cancelled = harness(); const abort = new AbortController(); abort.abort("cancelled");
  assert.equal((await cancelled.run(undefined, true, abort.signal)).status, "error");
  assert.equal(cancelled.events.includes("chat"), false);
});

test("a late completion cannot convert a deadline into a pass", async () => {
  const h = harness();
  const result = await h.run((time) => {
    if (time === 500) { h.agent.finished = { at: time }; h.setState(observation({ inventory: { oak_log: 2 } })); }
  });
  assert.equal(result.status, "timeout");
});

test("placement observations follow the initial fixed cell through trial snapshots", async () => {
  const scenario = scenarios.find((s) => s.id === "place_block_in_front")!;
  const positions = [{ x: 0, y: -60, z: 1 }];
  let snapshots = 0;
  let time = 0;
  const agent: TrialAgent = {
    acceptedAt: 0, finished: null, failure: null, arm: async () => undefined,
    snapshot: async (requested) => {
      assert.deepEqual(requested, positions);
      snapshots++;
      if (snapshots === 2) agent.finished = { at: time };
      return observation({ blocks: [{ position: positions[0]!, name: snapshots >= 2 ? "oak_planks" : "air" }] });
    },
  };
  const result = await runTrial({
    scenario, agent,
    initial: observation({ inventory: { oak_planks: 1 }, blocks: [{ position: positions[0]!, name: "air" }] }),
    timeoutMs: 500, acceptanceTimeoutMs: 200, pollMs: 50,
    now: () => time, wait: async (ms) => { time += ms; },
    sendChat: async () => undefined, record: () => undefined, inArena: () => true,
  });
  assert.equal(snapshots, 3, "Completion requires a fresh snapshot requested after the finished event.");
  assert.equal(result.status, "passed");
  assert.equal(result.goalReachedAtMs, 50);
  assert.deepEqual(result.final?.blocks, [{ position: positions[0], name: "oak_planks" }]);
});

test("trial evaluates enriched controller observations and preserves them in the result", async () => {
  const s = scenarios.find((s) => s.id === "chest_deposit")!;
  const position = { x: 3, y: -60, z: 0 };
  const before = observation({ inventory: { oak_log: 4 }, blocks: [{ position, name: "chest" }], containers: [{ position, inventory: {} }] });
  const after = { ...before, inventory: { oak_log: 2 }, containers: [{ position, inventory: { oak_log: 2 } }] };
  const agent: TrialAgent = { acceptedAt: 0, finished: { at: 0 }, failure: null,
    arm: async () => undefined, snapshot: async () => assert.fail("Must use the controller-enriched snapshot") };
  const result = await runTrial({ scenario: s, agent, initial: before, timeoutMs: 100, acceptanceTimeoutMs: 50, pollMs: 10,
    snapshot: async () => after, sendChat: async () => undefined, record: () => undefined, now: () => 0, inArena: () => true });
  assert.equal(result.status, "passed");
  assert.deepEqual(result.final?.containers, after.containers);
});

test("a stale successful sample received during completion cannot validate a later failing state", async () => {
  const h = harness();
  let samples = 0;
  h.agent.snapshot = async () => {
    samples++;
    if (samples === 1) {
      h.agent.finished = { at: 0 };
      return observation({ inventory: { oak_log: 2 } });
    }
    return observation({ inventory: {} });
  };
  const result = await h.run();
  assert.equal(samples, 2);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.final?.inventory, {});
});

test("container verdict waits for matching post-finish samples from both clients", async () => {
  let samples = 0, time = 0;
  const position = { x: 3, y: -60, z: 0 };
  const initial = observation({ inventory: { oak_log: 4 }, containers: [{ position, inventory: {} }], blocks: [{ position, name: "chest" }] });
  const agent: TrialAgent = { acceptedAt: 0, finished: { at: 0 }, failure: null, arm: async () => undefined,
    snapshot: async () => {
      samples++;
      return { ...initial, inventory: { oak_log: samples === 1 ? 4 : 2 }, containers: [{ position, inventory: { oak_log: 2 } }] };
    } };
  const result = await runTrial({ scenario: scenarios.find((s) => s.id === "chest_deposit")!, agent, initial,
    timeoutMs: 500, acceptanceTimeoutMs: 50, pollMs: 10, now: () => time, wait: async (ms) => { time += ms; },
    sendChat: async () => undefined, record: () => undefined, inArena: () => true });
  assert.equal(result.status, "passed");
  assert.equal(samples, 3);
});

test("unknown chest contents are an observation error, not an agent failure or empty inventory", async () => {
  const h = harness(); h.agent.finished = { at: 0 };
  h.setState(observation({ containers: [{ position: { x: 0, y: 0, z: 0 }, inventory: null, error: { code: "INVALID_CHEST_NBT", message: "Missing Items" } }] }));
  const result = await h.run();
  assert.equal(result.status, "error");
  assert.match(result.error!, /INVALID_CHEST_NBT/);
});
