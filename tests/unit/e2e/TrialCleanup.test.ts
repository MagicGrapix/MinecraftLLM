import assert from "node:assert/strict";
import test from "node:test";
import { cleanupTrial } from "../../e2e/TrialCleanup";
import type { TrialResult } from "../../e2e/types";

function result(status: TrialResult["status"] = "error"): TrialResult {
  return { scenario: "craft_table", status, timeoutMs: 300_000, startedAt: "2026-10-03T15:00:00Z",
    durationMs: 12_000, goalReachedAtMs: null, ...(status === "error" ? { error: "Worker snapshot timed out" } : {}) };
}

test("an observation error is preserved and permits the next reset after process exit and server confirmation", async () => {
  const events: string[] = [];
  const trial = result();
  await cleanupTrial({
    chat: async (text) => { events.push(text); },
    waitDisconnected: async () => { events.push("server confirms disconnect"); },
  }, { failure: null, close: async () => { events.push("process exited"); return false; } }, trial, () => undefined);
  events.push("next reset");
  assert.deepEqual(events, ["stop", "process exited", "server confirms disconnect", "next reset"]);
  assert.equal(trial.status, "error");
  assert.equal(trial.error, "Worker snapshot timed out");
  assert.equal(trial.forcedShutdown, false);
});

test("setup errors without a child still require server/controller confirmation", async () => {
  let checked = false;
  await cleanupTrial({ chat: async () => assert.fail("No child to stop"),
    waitDisconnected: async () => { checked = true; } }, null, result(), () => undefined);
  assert.equal(checked, true);
  await assert.rejects(cleanupTrial({ chat: async () => undefined,
    waitDisconnected: async () => { throw new Error("Controller disconnected"); } }, null, result(), () => undefined), /Controller disconnected/);
});

test("failure to close a child is fatal rather than permitting another reset", async () => {
  await assert.rejects(cleanupTrial({ chat: async () => undefined,
    waitDisconnected: async () => assert.fail("Must confirm process exit first") },
  { failure: null, close: async () => { throw new Error("Forced bot process exit timed out"); } }, result(), () => undefined), /process exit timed out/);
});

test("a process exit without confirmed server disconnect remains fatal", async () => {
  await assert.rejects(cleanupTrial({ chat: async () => undefined,
    waitDisconnected: async () => { throw new Error("Server-confirmed test bot disconnect timed out"); } },
  { failure: null, close: async () => false }, result(), () => undefined), /disconnect timed out/);
});

test("confirmed forced shutdown preserves timeout but invalidates a would-be pass", async () => {
  for (const status of ["timeout", "passed"] as const) {
    const trial = result(status);
    await cleanupTrial({ chat: async () => undefined, waitDisconnected: async () => undefined },
      { failure: "Bot connection lost", close: async () => true }, trial, () => undefined);
    assert.equal(trial.forcedShutdown, true);
    assert.equal(trial.status, status === "timeout" ? "timeout" : "error");
  }
});

test("failed stop chat is recorded but a confirmed shutdown can still recover", async () => {
  const events: string[] = [];
  await cleanupTrial({ chat: async () => { throw new Error("Chat send failed"); }, waitDisconnected: async () => undefined },
    { failure: null, close: async () => false }, result(), (name) => events.push(name));
  assert.deepEqual(events, ["stop.chat_error"]);
});
