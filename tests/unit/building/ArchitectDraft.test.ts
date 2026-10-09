import assert from "node:assert/strict";
import test from "node:test";
import { ArchitectDraft } from "../../../src/building/ArchitectDraft";

const plan = { width: 3, depth: 2, height: 2, description: "Floor, then walls." };

test("draft renders rectangular X templates, fixed dimensions, description and 1-based layers", () => {
  const draft = new ArchitectDraft();
  assert.equal(draft.start(plan).ok, true);
  assert.match(draft.render(), /width 3 \(X\), depth 2 \(Z\), height 2 \(Y\)/);
  assert.match(draft.render(), /Plan: Floor, then walls/);
  assert.match(draft.render(), /Layer 1 — not defined:\nXXX\nXXX/);
  assert.match(draft.render(), /Layer 2 — not defined:\nXXX\nXXX/);
  assert.match(draft.render(), /0\/2 layers defined/);
});

test("edits may arrive out of order and replace previous layers; CRLF has the same geometry", () => {
  const draft = new ArchitectDraft();
  draft.start(plan);
  draft.setLayer(2, "A.A\r\nAAA");
  draft.setLayer(1, "AAA\nAAA");
  draft.setLayer(2, "A.A\nA.A");
  const result = draft.finish();
  assert.ok(result.ok);
  assert.deepEqual(result.value.layers, [["AAA", "AAA"], ["A.A", "A.A"]]);
  assert.equal(result.value.description, plan.description);
  assert.deepEqual(result.value.dependencies, { doors: [] });
});

test("diagnostics annotate rows and columns without modifying a previously accepted layer", () => {
  const draft = new ArchitectDraft();
  draft.start(plan);
  draft.setLayer(1, "AAA\nAAA");
  const before = draft.render();
  const result = draft.setLayer(1, "AAAA\nAXA");
  assert.ok(!result.ok);
  assert.match(String(result.error.facts?.annotatedDrawing), /AAAA  # Row 1: 4 characters; expected 3/);
  assert.match(String(result.error.facts?.annotatedDrawing), /Row 2, column\(s\) 2/);
  assert.equal(draft.render(), before);
  for (const text of ["AAA", "AAA\nAAA\nAAA", "AAA\nAAA\n", "AAA\nAA ", "AAA\n😀A.", "AAA\nA#.", "AAA\n\nAAA"]) {
    assert.equal(draft.setLayer(1, text).ok, false, text);
    assert.equal(draft.render(), before);
  }
});

test("missing rows are displayed and diagnostic size is bounded", () => {
  const draft = new ArchitectDraft();
  draft.start(plan);
  const missing = draft.setLayer(1, "AAA");
  assert.ok(!missing.ok);
  assert.match(String(missing.error.facts?.annotatedDrawing), /<missing row>  # Row 2: missing row/);
  const oversized = draft.setLayer(1, "X\n".repeat(1000));
  assert.ok(!oversized.ok);
  assert.ok(String(oversized.error.facts?.annotatedDrawing).length < 6000);
});

test("finish rejects uninitialized, missing and entirely empty layers; no inferred height shrink", () => {
  const draft = new ArchitectDraft();
  assert.equal(draft.setLayer(1, "AAA\nAAA").ok, false);
  assert.equal(draft.finish().ok, false);
  draft.start(plan);
  assert.equal(draft.setLayer(3, "AAA\nAAA").ok, false);
  draft.setLayer(1, "...\n...");
  const incomplete = draft.finish();
  assert.ok(!incomplete.ok);
  assert.deepEqual(incomplete.error.facts?.missingLayers, [2]);
  draft.setLayer(2, "...\n...");
  const empty = draft.finish();
  assert.ok(!empty.ok);
  assert.match(empty.error.message, /at least one A/);
  assert.doesNotMatch(empty.error.message, /submit all layers again/);
});

test("restarting updates only description; changed dimensions never silently destroy layers; reset is pristine", () => {
  const draft = new ArchitectDraft();
  draft.start(plan);
  draft.setLayer(1, "AAA\nAAA");
  assert.equal(draft.start({ ...plan, description: "Revised plan" }).ok, true);
  assert.match(draft.render(), /Revised plan/);
  assert.match(draft.render(), /Layer 1:\nAAA\nAAA/);
  const before = draft.render();
  assert.equal(draft.start({ ...plan, width: 4 }).ok, false);
  assert.equal(draft.render(), before);
  draft.reset();
  assert.match(draft.render(), /^No draft yet/);
  assert.equal(draft.finish().ok, false);
});
