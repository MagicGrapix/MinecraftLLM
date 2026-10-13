import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { z } from "zod";
import type { MinecraftRuntime } from "../../../src/runtime/MinecraftRuntime";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { Executor } from "../../../src/execution/Executor";
import { TaskFactory } from "../../../src/execution/TaskFactory";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { Builder } from "../../../src/building/Builder";
import { success } from "../../../src/execution/TaskResult";
import { TestBuildOperations } from "../../support/building";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import type { ScaffoldState } from "../../../src/building/BuildTypes";

const input = { blueprintId: "bp_00000000-0000-0000-0000-000000000001", origin: { x: 0, y: 0, z: 0 } };
const tasks = new TaskFactory();
const task = () => tasks.create({ capability: "build", input: {} });
function harness(scaffolding = false) {
  const compiled = new BlueprintValidator(new MaterialCatalog(minecraftData("1.21.11"))).validate({ name: "test", description: "", width: scaffolding ? 1 : 2, depth: 1, palette: { A: "oak_planks" }, layers: scaffolding ? [["A"], ["A"], ["A"], ["A"], ["A"]] : [["AA"]], dependencies: { doors: [] } });
  assert.ok(compiled.ok);
  const ops = new TestBuildOperations(), registry = new CapabilityRegistry();
  const state: ScaffoldState = [];
  if (scaffolding) ops.stock.set("dirt", 24);
  let context: ExecutionContext;
  registry.register({ name: "build", defaultTimeoutMs: 300_000, inputSchema: z.object({}),
    execute: async (_input, c) => {
      context = c;
      return new Builder(ops, state).build(compiled.value, input, { signal: c.signal, progress: (p) => c.reportProgress?.({ build: p }) });
    },
  });
  const executor = new Executor({ registry, runtime: {} as MinecraftRuntime, world: {} as WorldQueries, cancellationGraceMs: 0 });
  return { ops, executor, state, context: () => context! };
}

test("in-flight scaffold placement retains the Executor lock and ownership across stop/resume", async () => {
  const h = harness(true);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  h.ops.onPlace = async () => {
    if (h.ops.placements.length === 2) { started(); await pending; }
    return success({});
  };
  const running = h.executor.execute(task()); await entered;
  assert.equal(h.state.length, 1); assert.equal(h.state[0]!.stateId, null);
  h.executor.abortCurrent("Stop during scaffold placement");
  const result = await running;
  assert.ok(!result.ok); assert.equal(result.error.facts?.stillSettling, true);
  const busy = await h.executor.execute(task()); assert.ok(!busy.ok); assert.equal(busy.error.code, "BLOCKED");
  release(); await h.executor.waitForIdle(1000);
  assert.equal(h.ops.placements.length, 3); assert.equal(h.ops.removals.length, 0);
  assert.notEqual(h.state[0]!.stateId, null);
  h.ops.onPlace = undefined;
  const resumed = await h.executor.execute(task()); assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(h.state.length, 0); assert.ok(h.ops.removals.length > 0);
});

for (const mode of ["stop", "timeout"] as const) test(`build ${mode} keeps the outer lock while a placement settles and starts no next operation`, async () => {
  const h = harness();
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  h.ops.onPlace = async () => { started(); await pending; return success({}); };
  const running = h.executor.execute({ ...task(), ...(mode === "timeout" ? { timeoutMs: 10 } : {}) });
  await entered;
  const blocked = await h.executor.execute(task()); assert.ok(!blocked.ok); assert.equal(blocked.error.code, "BLOCKED");
  if (mode === "stop") h.executor.abortCurrent("User stop");
  const result = await running; assert.ok(!result.ok); assert.equal(result.error.code, mode === "stop" ? "INTERRUPTED" : "TIMEOUT");
  assert.equal(result.error.facts!.stillSettling, true);
  assert.ok(result.error.facts!.progress);
  await assert.rejects(h.executor.waitForIdle(0));
  release(); await h.executor.waitForIdle(1000);
  assert.equal(h.ops.placements.length, 1);
  h.ops.onPlace = undefined;
  const resumed = await h.executor.execute(task()); assert.ok(resumed.ok);
  assert.equal(h.ops.placements.length, 2);
});

test("internal cancellation barriers retain the build lock after the builder returns", async () => {
  const h = harness(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  h.ops.onPlace = async () => { h.context().deferCancellationUntil(barrier); return success({}); };
  const result = await h.executor.execute({ ...task(), timeoutMs: 10 });
  assert.ok(!result.ok); assert.equal(result.error.code, "TIMEOUT");
  assert.equal(result.error.facts!.stillSettling, true);
  release(); await h.executor.waitForIdle(1000);
});

test("capability default timeout overrides global default but an explicit task timeout wins", async () => {
  const registry = new CapabilityRegistry();
  registry.register({ name: "build", inputSchema: z.object({}), defaultTimeoutMs: 1000,
    execute: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return success({}); },
  });
  const executor = new Executor({ registry, runtime: {} as MinecraftRuntime, world: {} as WorldQueries, defaultTimeoutMs: 1 });
  assert.ok((await executor.execute(task())).ok);
  const result = await executor.execute({ ...task(), timeoutMs: 1 });
  assert.ok(!result.ok); assert.equal(result.error.code, "TIMEOUT");
});
