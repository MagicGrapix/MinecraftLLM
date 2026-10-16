import assert from "node:assert/strict";
import test from "node:test";
import { parseStepChecks } from "../../../src/agent/StepChecks";
import { evaluateStepChecks, formatStepEvaluation } from "../../../src/agent/StepCheckEvaluator";
import { StepEvaluationService } from "../../../src/agent/StepEvaluationService";
import { WorkflowState } from "../../../src/agent/WorkflowState";
import { inventoryTotals } from "../../../src/runtime/InventoryAdapter";
import { PLAN_LIMITS } from "../../../src/config";

const known = (name: string) => ["stick", "oak_planks"].includes(name);
const parse = (value: string) => parseStepChecks(value, known, 4);
const planned = (checks: string) => [{ title: "Have sticks", successCriteria: "Stock of at least four sticks.", checks }];
const signal = () => new AbortController().signal;

test("closed grammar accepts CRLF, whitespace, empty fields and all three comparisons", () => {
  assert.deepEqual(parse(" \r\n\t"), []);
  assert.deepEqual(parse("\n inventory_count ( stick ) >= 4\r\n\r\ninventory_count(oak_planks)==2\ninventory_count(stick) <= 8"), [
    { line: 2, item: "stick", operator: ">=", expected: 4 },
    { line: 4, item: "oak_planks", operator: "==", expected: 2 },
    { line: 5, item: "stick", operator: "<=", expected: 8 },
  ]);
});

for (const expression of [
  "inventory_total(stick) >= 4", "inventory_count(stick) > 4", "inventory_count(stick) != 4",
  "inventory_count(minecraft:stick) >= 4", "inventory_count('stick') >= 4", "inventory_count(fake) >= 4",
  "inventory_count(stick) >= -1", "inventory_count(stick) >= 1.5", "inventory_count(stick) >= 1e3",
  "inventory_count(stick) >= 0x10", "inventory_count(stick) >= 9007199254740992",
  "inventory_count(stick) >= 1 # comment", "inventory_count(stick) >= 1 OR true", "inventory_count(stick) >= 1 && true",
  "inventory_count(stick) >= 1 + 2", "inventory_count(foo()) >= 1", "inventory_count(stick).count >= 1",
  "inventory_count(stick) >= 1; process.exit()", "process.exit()", "__proto__() == 1",
]) test(`rejects input without executing it: ${expression}`, () => {
  assert.throws(() => parse(`\n${expression}`), error => {
    assert.match((error as Error).message, /step 4, line 2/);
    assert.match((error as Error).message, /Example: inventory_count\(stick\) >= 4/);
    return true;
  });
});

test("limits and simple contradictions refuse the complete field", () => {
  assert.equal(parse(Array(8).fill("inventory_count(stick) >= 0").join("\n")).length, 8);
  assert.throws(() => parse(Array(9).fill("inventory_count(stick) >= 0").join("\n")), /Maximum 8/);
  assert.throws(() => parse(" ".repeat(PLAN_LIMITS.checkChars + 1)), /Maximum 2000/);
  for (const expression of [
    "inventory_count(stick) >= 5\ninventory_count(stick) <= 4",
    "inventory_count(stick) == 4\ninventory_count(stick) == 5",
    "inventory_count(stick) <= 2\ninventory_count(stick) == 4",
  ]) assert.throws(() => parse(expression), /Contradictory/);
});

test("pure evaluation distinguishes false, known zero, unavailable and no requirements", () => {
  const checks = parse("inventory_count(stick) >= 4\ninventory_count(oak_planks) <= 2");
  const stock = inventoryTotals([{ name: "stick", count: 2 }, { name: "stick", count: 2 }, { name: "oak_planks", count: 3 }]);
  const result = evaluateStepChecks(1, checks, { known: true, items: stock });
  assert.equal(result.verdict, false);
  assert.deepEqual(result.checks.map(c => c.passed), [true, false]);
  assert.match(formatStepEvaluation(result), /stick: 4 >= 4 — true/);
  assert.equal(evaluateStepChecks(1, parse("inventory_count(stick) == 0"), { known: true, items: {} }).verdict, true);
  assert.equal(evaluateStepChecks(1, checks, { known: false, reason: "DISCONNECTED", message: "Disconnected" }).verdict, null);
  assert.equal(evaluateStepChecks(1, [], { known: true, items: {} }).reason, "NO_DETERMINISTIC_REQUIREMENTS");
  assert.equal(evaluateStepChecks(1, checks, { known: true, items: { stick: NaN } }).verdict, null);
});

test("service reads once, enforces delegation scope and never reads for missing checks or invalid indices", async () => {
  const state = new WorkflowState();
  state.applyPlan([...planned("inventory_count(stick) >= 4\ninventory_count(oak_planks) <= 2"), ...planned("")], [], known);
  let reads = 0;
  const service = new StepEvaluationService(state, async () => { reads++; return { known: true, items: { stick: 4 } }; });
  const scope = { step: 1, planVersion: state.planVersion };
  assert.equal((await service.evaluate(1, signal(), scope)).verdict, true);
  assert.equal(reads, 1);
  await assert.rejects(service.evaluate(2, signal(), scope), /delegated step/);
  await assert.rejects(service.evaluate(1, signal(), { ...scope, planVersion: 0 }), /current plan/);
  await assert.rejects(service.evaluate(99, signal()), /existing step/);
  assert.equal((await service.evaluate(2, signal())).reason, "NO_DETERMINISTIC_REQUIREMENTS");
  assert.equal(reads, 1);
});

test("invalid plan is atomic and stale observations after replan, new request or stop are rejected", async () => {
  const state = new WorkflowState();
  state.applyPlan(planned("inventory_count(stick) >= 4"), [], known);
  const before = state.snapshot();
  assert.throws(() => state.applyPlan(planned("inventory_count(stick) > 4"), [], known));
  assert.deepEqual(state.snapshot(), before);
  for (const change of [() => state.applyPlan(planned("inventory_count(stick) >= 4"), [], known), () => state.start("New task")]) {
    state.applyPlan(planned("inventory_count(stick) >= 4"), [], known);
    const service = new StepEvaluationService(state, async () => { change(); return { known: true, items: { stick: 4 } }; });
    await assert.rejects(service.evaluate(1, signal()), /replaced plan/);
  }
  state.applyPlan(planned("inventory_count(stick) >= 4"), [], known);
  const abort = new AbortController();
  const service = new StepEvaluationService(state, async () => { abort.abort(new Error("Stop")); return { known: true, items: { stick: 4 } }; });
  await assert.rejects(service.evaluate(1, abort.signal), /Stop/);
});
