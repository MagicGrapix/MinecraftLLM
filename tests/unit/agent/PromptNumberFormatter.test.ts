import assert from "node:assert/strict";
import test from "node:test";
import { promptNumbers } from "../../../src/agent/PromptNumberFormatter";

test("prompt numbers round nested data without changing counts, text, or originals", () => {
  const raw = { position: { x: 10.53869625851037, y: -60, z: -3.141592 }, count: 1, items: [2.7182818, null], id: "10.53869625851037" };
  const before = structuredClone(raw);
  assert.deepEqual(promptNumbers(raw), { position: { x: 10.54, y: -60, z: -3.14 }, count: 1, items: [2.72, null], id: "10.53869625851037" });
  assert.deepEqual(raw, before);
});
