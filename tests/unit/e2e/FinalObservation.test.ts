import assert from "node:assert/strict";
import test from "node:test";
import { settledObservation } from "../../e2e/FinalObservation";
import { observation } from "../../support/ScenarioObservations";

test("final observation settles producers first and needs two known stable snapshots", async () => {
  let settled = false, reads = 0;
  const final = await settledObservation({
    settle: async () => { settled = true; }, pollMs: 1,
    snapshot: async () => {
      assert.equal(settled, true); reads++;
      return observation({ blocks: [{ position: { x: 0, y: 0, z: 0 }, name: reads === 1 ? null : "air" }] });
    },
  });
  assert.equal(reads, 3);
  assert.equal(final.blocks[0]!.name, "air");
});

test("final observation refuses busy physical execution and propagates settlement failure", async () => {
  await assert.rejects(settledObservation({ settle: async () => undefined,
    snapshot: async () => observation({ physicalIdle: false }) }), /not idle/);
  await assert.rejects(settledObservation({ settle: async () => { throw new Error("still executing"); },
    snapshot: async () => { assert.fail("Must not read before settlement"); } }), /still executing/);
});

test("unknown final cells and unresponsive observations fail within a deadline", async () => {
  await assert.rejects(settledObservation({ settle: async () => undefined, timeoutMs: 20, pollMs: 1,
    snapshot: async () => observation({ blocks: [{ position: { x: 7, y: -60, z: 8 }, name: null }] }) }), /Unavailable.*"x":7/);
  await assert.rejects(settledObservation({ settle: async () => undefined, timeoutMs: 20,
    snapshot: () => new Promise(() => undefined) }), /Final observation/);
});
