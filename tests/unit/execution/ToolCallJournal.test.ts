import assert from "node:assert/strict";
import test from "node:test";
import { ToolCallJournal, formatInventoryDiff } from "../../../src/execution/ToolCallJournal";
import { inventoryTotals } from "../../../src/runtime/InventoryAdapter";
import { inventoryDiffQuery } from "../../../src/world/queries/GetInventoryDiff";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { setTraceSink } from "../../../src/TraceLog";

test("journal counts every tool, nests delegations and freezes before/after observations", () => {
  const inventory = { oak_log: 1 };
  const journal = new ToolCallJournal(() => inventory);
  journal.startRequest();
  const parent = journal.start("run_step", true);
  const read = journal.start("get_block", false);
  journal.complete(read, true);
  const dig = journal.start("dig", true);
  inventory.oak_log = 2;
  journal.complete(dig, true);
  inventory.oak_log = 3;
  journal.complete(parent, true);
  assert.deepEqual([parent, read, dig], [1, 2, 3]);
  assert.equal(journal.get(read)!.tracksInventory, false);
  assert.equal(journal.get(dig)!.before!.oak_log, 1);
  assert.equal(journal.get(dig)!.after!.oak_log, 2);
  assert.equal(journal.get(parent)!.after!.oak_log, 3);
  inventory.oak_log = 9;
  const clone = journal.get(dig)!;
  (clone.after as Record<string, number>).oak_log = 50;
  journal.complete(dig, false); // Duplicate finalization cannot move the boundary.
  assert.equal(journal.get(dig)!.after!.oak_log, 2);
  assert.equal(journal.get(dig)!.ok, true);
});

test("journal distinguishes unavailable inventories from empty, and records failed actions", () => {
  let inventory: Record<string, number> | null = { dirt: 2 };
  const journal = new ToolCallJournal(() => inventory);
  const action = journal.start("place", true);
  inventory = {};
  journal.complete(action, false);
  assert.equal(journal.get(action)!.ok, false);
  assert.match(formatInventoryDiff(journal.get(action)!), /- dirt: 2/);
  const interrupted = journal.start("goto", true);
  inventory = null;
  journal.complete(interrupted, false);
  assert.equal(journal.get(interrupted)!.after, null);
  const disconnected = new ToolCallJournal(() => { throw new Error("Disconnected"); });
  const n = disconnected.start("dig", true);
  disconnected.complete(n, false);
  assert.equal(disconnected.get(n)!.before, null);
  assert.equal(disconnected.get(n)!.after, null);
});

test("inventory totals ignore slots and diff sorts only changed quantities", () => {
  assert.deepEqual(inventoryTotals([{ name: "oak_log", count: 1 }, { name: "oak_log", count: 2 }]), { oak_log: 3 });
  let inventory = { oak_log: 2, dirt: 5 } as Record<string, number>;
  const journal = new ToolCallJournal(() => inventory);
  const n = journal.start("craft_from_inventory_2x2", true);
  inventory = { dirt: 5, oak_planks: 4, oak_log: 1 };
  journal.complete(n, true);
  assert.equal(formatInventoryDiff(journal.get(n)!), "--- before action #1\n+++ after action #1\n- oak_log: 2\n+ oak_log: 1\n+ oak_planks: 4");
});

test("diff query is fixed, non-consuming and zero changes never replay an older gain", async () => {
  let inventory = { oak_log: 0 };
  const journal = new ToolCallJournal(() => inventory);
  const query = inventoryDiffQuery(journal);
  const world = {} as WorldQueries;
  const pickup = journal.start("goto", true);
  inventory = { oak_log: 1 };
  journal.complete(pickup, true);
  const dig = journal.start("dig", true);
  journal.complete(dig, true);
  const expected = await query.execute({ actionNumber: pickup }, world);
  inventory = { oak_log: 2 }; // Late pickup must not rewrite either diff.
  assert.deepEqual(await query.execute({ actionNumber: pickup }, world), expected);
  assert.deepEqual(await query.execute({ actionNumber: dig }, world), {
    ok: true, value: { actionNumber: dig, tool: "dig", toolSucceeded: true, diff: "No inventory changes during action #2." },
  });
});

test("diff query reports missing, read-only, in-progress and unknown snapshots explicitly", async () => {
  const journal = new ToolCallJournal(() => null);
  const query = inventoryDiffQuery(journal);
  const read = journal.start("get_inventory", false);
  journal.complete(read, true);
  const running = journal.start("run_step", true);
  const unknown = journal.start("dig", true);
  journal.complete(unknown, false);
  for (const [n, pattern] of [[99, /not in the current/], [read, /not an inventory-tracked/], [running, /still running/], [unknown, /unavailable/]] as const) {
    const result = await query.execute({ actionNumber: n }, {} as WorldQueries);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, pattern);
  }
  for (const input of [{}, { actionNumber: "1" }, { actionNumber: 0 }, { actionNumber: 1.5 }, { actionNumber: 1, to: 2 }]) {
    assert.equal(query.inputSchema.safeParse(input).success, false);
  }
});

test("new requests clear data, never reuse numbers, and reject clearing a running delegation", () => {
  const journal = new ToolCallJournal(() => ({}));
  const first = journal.start("run_step", true);
  assert.throws(() => journal.startRequest(), /running/);
  journal.complete(first, true);
  journal.startRequest();
  assert.equal(journal.get(first), undefined);
  assert.equal(journal.start("reply", false), 2);
});

test("journal persists numbered snapshots through the existing trace sink without an inspector", () => {
  const events: { event: string; data: any }[] = [];
  setTraceSink((event, data) => events.push({ event, data }));
  try {
    const journal = new ToolCallJournal(() => ({ dirt: 2 }));
    const n = journal.start("dig", true, { agent: "actioner", generationId: 1, toolCallId: "dig-1", arguments: '{"position":{"x":0,"y":-60,"z":0}}' });
    journal.complete(n, false, '{"ok":false,"error":{"code":"OUT_OF_REACH"}}');
    assert.deepEqual(events.map(({ event }) => event), ["tool.started", "tool.completed"]);
    assert.equal(events[1]!.data.actionNumber, 1);
    assert.deepEqual(events[1]!.data.after, { dirt: 2 });
    assert.equal(events[0]!.data.context.agent, "actioner");
    assert.equal(JSON.parse(events[1]!.data.result).error.code, "OUT_OF_REACH");
    assert.equal("result" in journal.get(n)!, false);
  } finally { setTraceSink(() => undefined); }
});
