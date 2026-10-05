import assert from "node:assert/strict";
import test from "node:test";
import { cleanupSteps } from "../../../src/runtime/cleanup";

test("cleanup attempts disconnect despite a rejected save and a hung window close", async () => {
  const calls: string[] = [];
  await assert.rejects(cleanupSteps([
    { name: "save", run: () => { calls.push("save"); throw new Error("disk full"); } },
    { name: "window", run: () => { calls.push("window"); return new Promise(() => undefined); } },
    { name: "disconnect", run: () => { calls.push("disconnect"); } },
  ], 10), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(calls, ["save", "window", "disconnect"]);
});
