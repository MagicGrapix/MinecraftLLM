import assert from "node:assert/strict";
import test from "node:test";
import { WorkingMemory } from "../../../src/agent/WorkingMemory";

test("working memory replaces atomically and rejects oversized text", () => {
  const memory = new WorkingMemory(20);
  memory.replace("  keep this  ");
  assert.equal(memory.read(), "keep this");
  assert.throws(() => memory.replace("x".repeat(21)), /exceeds 20/);
  assert.equal(memory.read(), "keep this");
  memory.clear();
  assert.equal(memory.read(), "");
});
