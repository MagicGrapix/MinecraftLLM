import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ResourceCollector } from "../../../src/collection/ResourceCollector";
import type { CollectionProgress } from "../../../src/collection/CollectionTypes";
import { failure, success } from "../../../src/execution/TaskResult";
import { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import { CollectResourceCapability } from "../../../src/capabilities/CollectResource";
import { Executor } from "../../../src/execution/Executor";
import { TaskFactory } from "../../../src/execution/TaskFactory";
import { TestCollectionOperations, oakResource } from "../../support/collection";
import { QueryExecutionError } from "../../../src/world/queries/QueryLimits";

const run = (ops: TestCollectionOperations, quantity = 4) => new ResourceCollector(ops).collect(oakResource, quantity, { signal: new AbortController().signal });

test("one existing log plus four requested means five in inventory, not four blocks simply dug", async () => {
  const ops = new TestCollectionOperations();
  const trace: Record<string, unknown>[] = [];
  const result = await new ResourceCollector(ops).collect(oakResource, 4, { signal: new AbortController().signal, trace: e => trace.push(e) });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(ops.count, 5); assert.equal(result.value.collected, 4);
  assert.equal(result.value.sourcesBroken, 4);
  assert.ok(JSON.stringify(result).length < 1000);
  const started = trace.filter(e => e.event === "operation_started");
  assert.deepEqual(started.map(e => e.index), started.map((_, i) => i + 1));
  assert.equal(trace.filter(e => e.event === "operation_finished").length, started.length);
});

test("matching loose stacks are used before mining, and surplus pickup is reported", async () => {
  const ops = new TestCollectionOperations();
  ops.loose = [{ id: 1, count: 2, position: { x: 2, y: 0, z: 0 } }, { id: 2, count: 3, position: { x: 3, y: 0, z: 0 } }];
  const result = await run(ops);
  assert.ok(result.ok); assert.equal(result.value.collected, 5); assert.equal(ops.dug.length, 0);
});

test("delayed loot is awaited before another source is mined", async () => {
  const ops = new TestCollectionOperations();
  ops.onDig = async () => success({});
  ops.onLoot = async () => { await delay(5); ops.loose.push({ id: 9, count: 4, position: { x: 3, y: 0, z: 0 } }); };
  const result = await run(ops);
  assert.ok(result.ok); assert.equal(ops.dug.length, 1); assert.equal(ops.waits, 1);
});

test("drop disappearance and arrival without inventory gain never prove pickup", async () => {
  const ops = new TestCollectionOperations(); ops.sources = [];
  ops.loose = [{ id: 1, count: 4, position: { x: 2, y: 0, z: 0 } }];
  ops.onMove = async () => { ops.loose = []; return success({}); };
  const result = await run(ops);
  assert.ok(!result.ok); assert.equal((result.error.facts?.progress as CollectionProgress).collected, 0);
});

test("moving drop positions are re-read on the next bounded attempt", async () => {
  const ops = new TestCollectionOperations(); ops.sources = [];
  ops.loose = [{ id: 4, count: 4, position: { x: 2, y: 0, z: 0 } }];
  ops.onMove = async p => {
    if (p.x === 2) ops.loose[0]!.position.x = 4;
    else { ops.count += 4; ops.loose = []; }
    return success({});
  };
  assert.ok((await run(ops)).ok);
  assert.deepEqual(ops.moves.map(m => m.position.x), [2, 4]);
});

test("inventory full or unknown stops without mining or movement", async () => {
  for (const unknown of [false, true]) {
    const ops = new TestCollectionOperations();
    if (unknown) ops.inventoryAvailable = false; else ops.capacity = 0;
    const result = await run(ops);
    assert.ok(!result.ok); assert.equal(result.error.code, unknown ? "ACTION_NOT_CONFIRMED" : "BLOCKED");
    assert.equal(ops.dug.length + ops.moves.length, 0);
  }
});

test("missing tool stops before approaching the source", async () => {
  const ops = new TestCollectionOperations();
  ops.onInspect = () => failure("MISSING_ITEM", "Need pickaxe");
  const result = await run(ops);
  assert.ok(!result.ok && result.error.code === "MISSING_ITEM");
  assert.equal(ops.dug.length + ops.moves.length, 0);
});

test("broken tool reports partial gain instead of claiming the whole request", async () => {
  const ops = new TestCollectionOperations();
  ops.onEquip = () => ops.dug.length ? failure("MISSING_ITEM", "Tool broke") : success({});
  const result = await run(ops);
  assert.ok(!result.ok && result.error.code === "MISSING_ITEM");
  assert.equal((result.error.facts?.progress as CollectionProgress).collected, 1);
});

test("vanished, unloaded and unreachable sources have bounded attempts and unique counters", async () => {
  for (const code of ["WORLD_CHANGED", "BLOCKED", "NO_PATH"] as const) {
    const ops = new TestCollectionOperations(); ops.sources = ops.sources.slice(0, 1);
    ops.onInspect = () => code === "NO_PATH" ? success({ canDig: false }) : failure(code, "Unavailable");
    ops.onMove = async () => failure("NO_PATH", "No path");
    const result = await run(ops);
    assert.ok(!result.ok);
    const progress = result.error.facts?.progress as CollectionProgress;
    assert.equal(progress.sourcesFound, 1); assert.equal(progress.accessFailed, 1); assert.equal(progress.collected, 0);
    assert.ok(ops.moves.length <= 2); assert.equal(ops.dug.length, 0);
  }
});

test("unconfirmed dig is never blindly repeated at the same cell", async () => {
  const ops = new TestCollectionOperations(); ops.sources = ops.sources.slice(0, 1);
  ops.onDig = async () => failure("ACTION_NOT_CONFIRMED", "No server confirmation");
  const result = await run(ops);
  assert.ok(!result.ok); assert.equal(ops.dug.length, 1);
});

test("gain obtained while moving avoids an unnecessary extraction and preserves search origin", async () => {
  const ops = new TestCollectionOperations(); ops.accessible = false;
  ops.onMove = async p => { ops.feet = { ...p }; ops.count += 4; return success({}); };
  const result = await run(ops);
  assert.ok(result.ok); assert.equal(ops.dug.length, 0);
  assert.ok(ops.searchOrigins.every(p => p.x === 0 && p.y === 0 && p.z === 0));
});

test("a temporary gain consumed before final observation does not satisfy collection", async () => {
  const ops = new TestCollectionOperations(); ops.sources = [];
  ops.loose = [{ id: 1, count: 4, position: { x: 2, y: 0, z: 0 } }];
  ops.onPickup = async () => { ops.count = 1; };
  const result = await run(ops);
  assert.ok(!result.ok); assert.equal((result.error.facts?.progress as CollectionProgress).collected, 0);
});

test("query timeouts remain errors rather than empty successful searches", async () => {
  const ops = new TestCollectionOperations();
  ops.search = async () => { throw new QueryExecutionError("QUERY_TIMEOUT", "Scan budget exhausted"); };
  const result = await run(ops);
  assert.ok(!result.ok && result.error.code === "TIMEOUT");
});

test("long upstream errors keep the model report compact and the trace intact", async () => {
  const ops = new TestCollectionOperations(), message = '"network error"\n'.repeat(200);
  ops.search = async () => { throw new Error(message); };
  const trace: Record<string, unknown>[] = [];
  const result = await new ResourceCollector(ops).collect(oakResource, 4, { signal: new AbortController().signal, trace: e => trace.push(e) });
  assert.ok(!result.ok);
  assert.ok(JSON.stringify(result).length < 1000);
  assert.ok(trace.some(e => e.error === message));
});

test("dimension changes and out-of-bounds navigation stop collection", async () => {
  for (const dimensionChange of [true, false]) {
    const ops = new TestCollectionOperations(); ops.accessible = false;
    ops.onMove = async () => { if (dimensionChange) ops.world = "nether"; else ops.feet.x = 51; return success({}); };
    const result = await run(ops);
    assert.ok(!result.ok && result.error.code === "WORLD_CHANGED"); assert.equal(ops.dug.length, 0);
  }
});

for (const phase of ["move", "dig", "pickup"] as const) {
  for (const cancellation of ["stop", "timeout"] as const) {
    test(`${cancellation} during ${phase} keeps the Executor locked until physical settlement`, async () => {
      const ops = new TestCollectionOperations(); let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(r => { enter = r; }), pending = new Promise<void>(r => { release = r; });
      const physical = async (_signal: AbortSignal) => { enter(); await pending; return success({}); };
      if (phase === "move") { ops.accessible = false; ops.onMove = async (_p, _k, signal) => physical(signal); }
      if (phase === "dig") ops.onDig = async (_p, signal) => physical(signal);
      if (phase === "pickup") {
        ops.loose = [{ id: 1, count: 1, position: { x: 2, y: 0, z: 0 } }];
        ops.onPickup = async signal => { await physical(signal); };
      }
      const schema = new CollectResourceCapability().inputSchema;
      const registry = new CapabilityRegistry();
      registry.register({ name: "collect_resource", inputSchema: schema, execute: (input, context) =>
        new ResourceCollector(ops).collect(oakResource, input.quantity, { signal: context.signal,
          progress: p => context.reportProgress?.({ collect: p }) }) });
      const executor = new Executor({ registry, runtime: {} as never, world: {} as never, cancellationGraceMs: 0 });
      const factory = new TaskFactory();
      const task = () => factory.create({ capability: "collect_resource", input: { item: "oak_log", quantity: 4 }, timeoutMs: cancellation === "timeout" ? 50 : 5000 });
      const running = executor.execute(task()); await entered;
      if (cancellation === "stop") executor.abortCurrent();
      const result = await running;
      assert.ok(!result.ok && result.error.code === (cancellation === "stop" ? "INTERRUPTED" : "TIMEOUT"));
      assert.equal(result.error.facts?.stillSettling, true); assert.ok(result.error.facts?.progress);
      const concurrent = await executor.execute(task()); assert.ok(!concurrent.ok && concurrent.error.code === "BLOCKED");
      release(); await executor.waitForIdle(1000);
      assert.ok(ops.dug.length <= 1);
    });
  }
}
