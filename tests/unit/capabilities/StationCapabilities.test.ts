import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { GetChestContentsCapability, UseChestCapability } from "../../../src/capabilities/Chest";
import { GetFurnaceContentsCapability, UseFurnaceCapability } from "../../../src/capabilities/Furnace";
import { selectStation } from "../../../src/runtime/StationInteraction";
import { stationBot, stationTiming } from "../../support/StationBot";
import { subscribeTrace } from "../../../src/TraceLog";

const chestRead = () => new GetChestContentsCapability(stationTiming);
const chestUse = () => new UseChestCapability(stationTiming);
const furnaceRead = () => new GetFurnaceContentsCapability(stationTiming);
const furnaceUse = () => new UseFurnaceCapability(stationTiming);
const deposit = { direction: "deposit" as const, item: "oak_log", quantity: 2 };
const smelt = { inputItem: "raw_iron", quantity: 3, fuel: "coal" };

test("read chest aggregates only server chest contents and always closes, without moving items or the bot", async () => {
  const f = stationBot();
  f.contents[0] = { item: "oak_log", count: 4 }; f.contents[1] = { item: "oak_log", count: 2 };
  f.inventory[0] = { item: "coal", count: 9 };
  const result = await chestRead().execute({}, f.context);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.deepEqual(result.value, { position: { x: 3, y: 64, z: 0 }, items: [{ item: "oak_log", count: 6 }], closed: true });
  assert.equal(f.bot.currentWindow, null); assert.equal(f.calls.includes("transfer"), false);
  assert.equal(f.client.listenerCount("window_items"), 0);
  assert.equal(f.client.listenerCount("open_window"), 0);
  assert.equal(f.bot.listenerCount("end"), 0);
  assert.equal(f.barriers.length, 1);
});

test("confirmed empty chest is an empty list, not an unknown observation", async () => {
  const f = stationBot(), result = await chestRead().execute({}, f.context);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.items, []);
});

for (const direction of ["deposit", "withdraw"] as const) test(`chest ${direction} confirms exact opposite deltas and bot inventory after close`, async () => {
  const f = stationBot();
  (direction === "deposit" ? f.inventory : f.contents)[0] = { item: "oak_log", count: 4 };
  f.options.syncDelay = 4;
  const result = await chestUse().execute({ ...deposit, direction }, f.context);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.value.transferred, 2);
    assert.equal(result.value.inventoryAfter, 2);
    assert.equal(result.value.chestAfter, 2);
  }
  assert.equal(f.bot.currentWindow, null);
  assert.equal(f.calls.filter(c => c === "transfer").length, 1);
});

test("withdraw can fill an existing stack even with no empty bot inventory slots", async () => {
  const f = stationBot();
  f.inventory.fill({ item: "coal", count: 64 }); f.inventory[0] = { item: "oak_log", count: 62 };
  f.contents[0] = { item: "oak_log", count: 2 };
  assert.equal((await chestUse().execute({ ...deposit, direction: "withdraw" }, f.context)).ok, true);
});

test("missing stock, destination full and unknown item do not attempt transfers", async () => {
  const f = stationBot();
  assert.equal((await chestUse().execute(deposit, f.context)).ok, false);
  f.inventory[0] = { item: "oak_log", count: 4 }; f.contents.fill({ item: "coal", count: 64 });
  assert.equal((await chestUse().execute(deposit, f.context)).ok, false);
  const unknown = await chestUse().execute({ ...deposit, item: "oak_plate" }, f.context);
  assert.ok(!unknown.ok && unknown.error.code === "INVALID_ARGUMENT");
  assert.equal(f.calls.includes("transfer"), false);
  assert.equal(f.bot.currentWindow, null);
});

test("a native error after a confirmed exact transfer is not retried or misreported", async () => {
  const f = stationBot(); f.inventory[0] = { item: "oak_log", count: 4 }; f.options.rejectTransfer = true;
  const result = await chestUse().execute(deposit, f.context);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.filter(c => c === "transfer").length, 1);
});

test("partial transfer reports its real quantity and never sends the full request again", async () => {
  const f = stationBot(); f.inventory[0] = { item: "oak_log", count: 4 };
  f.options.transferLimit = 1; f.options.rejectTransfer = true;
  const result = await chestUse().execute(deposit, f.context);
  assert.ok(!result.ok && result.error.code === "ACTION_NOT_CONFIRMED");
  if (!result.ok) assert.equal(result.error.facts?.transferred, 1);
  assert.equal(f.calls.filter(c => c === "transfer").length, 1);
  assert.equal(f.bot.currentWindow, null);
});

test("predicted or ignored transfers cannot pass server confirmation", async () => {
  const f = stationBot(); f.inventory[0] = { item: "oak_log", count: 4 }; f.options.ignoreTransfer = true;
  const result = await chestUse().execute(deposit, f.context);
  assert.ok(!result.ok && result.error.code === "ACTION_NOT_CONFIRMED");
  if (!result.ok) assert.equal(result.error.facts?.transferred, 0);
});

test("missing fresh server response is an error, never an empty chest", async () => {
  const f = stationBot(); f.options.suppressSync = true;
  const result = await chestRead().execute({}, f.context);
  assert.ok(!result.ok && result.error.code === "ACTION_NOT_CONFIRMED");
  assert.equal(f.bot.currentWindow, null);
});

test("selection does not use dig or ground conditions; absence, distance, obstruction and ambiguity are diagnosed", async () => {
  const f = stationBot();
  assert.equal((await selectStation(f.bot, "chest", f.abort.signal)).ok, true); // onGround=false
  f.cells.clear();
  let result = await selectStation(f.bot, "chest", f.abort.signal);
  assert.ok(!result.ok && result.error.code === "TARGET_NOT_FOUND");
  const distant = f.block("chest", new Vec3(7, 64, 0)); f.cells.set(distant.position.toString(), distant);
  result = await selectStation(f.bot, "chest", f.abort.signal);
  assert.ok(!result.ok && result.error.code === "OUT_OF_REACH");
  f.cells.clear();
  for (const pos of [new Vec3(3, 64, 0), new Vec3(0, 64, 3)]) f.cells.set(pos.toString(), f.block("chest", pos));
  result = await selectStation(f.bot, "chest", f.abort.signal);
  assert.ok(!result.ok && result.error.facts?.reason === "ambiguous_target");
  f.cells.delete(new Vec3(0, 64, 3).toString());
  for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) {
    const pos = new Vec3(2, y, z); f.cells.set(pos.toString(), f.block("stone", pos));
  }
  result = await selectStation(f.bot, "chest", f.abort.signal);
  assert.ok(!result.ok && result.error.facts?.reason === "occluded");
  assert.equal(f.calls.length, 0);
});

test("foreign windows and double chests are not used or closed", async () => {
  const f = stationBot(); const foreign = {} as NonNullable<typeof f.bot.currentWindow>;
  f.bot.currentWindow = foreign;
  assert.equal((await chestRead().execute({}, f.context)).ok, false);
  assert.equal(f.bot.currentWindow, foreign); assert.equal(f.calls.length, 0);
  f.bot.currentWindow = null; const pos = new Vec3(3, 64, 0);
  f.cells.set(pos.toString(), f.block("chest", pos, "left"));
  assert.equal((await chestRead().execute({}, f.context)).ok, false);
  assert.equal(f.calls.length, 0);
});

test("cancellation while opening waits for native completion then closes the late owned window", async () => {
  const f = stationBot(); f.options.openDelay = 20;
  const promise = chestRead().execute({}, f.context);
  setTimeout(() => f.abort.abort(), 5);
  const result = await promise;
  assert.ok(!result.ok && result.error.code === "INTERRUPTED");
  await Promise.all(f.barriers);
  assert.equal(f.bot.currentWindow, null);
  assert.equal(f.client.listenerCount("window_items"), 0);
});

test("replacement window is left untouched and cleanup failure cannot be success", async () => {
  const f = stationBot(); f.inventory[0] = { item: "oak_log", count: 4 };
  const foreign = {} as NonNullable<typeof f.bot.currentWindow>;
  f.options.beforeTransfer = () => { f.bot.currentWindow = foreign; };
  const result = await chestUse().execute(deposit, f.context);
  assert.equal(result.ok, false); assert.equal(f.bot.currentWindow, foreign);
  const g = stationBot(); g.options.closeFails = true;
  assert.equal((await chestRead().execute({}, g.context)).ok, false);
});

test("furnace read separates input/fuel/output and preserves early property packets", async () => {
  const f = stationBot("furnace");
  f.contents[0] = { item: "raw_iron", count: 3 }; f.contents[2] = { item: "iron_ingot", count: 1 };
  const result = await furnaceRead().execute({}, f.context);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.deepEqual(result.value.input, { item: "raw_iron", count: 3 });
    assert.equal(result.value.fuel, null);
    assert.deepEqual(result.value.output, { item: "iron_ingot", count: 1 });
    assert.equal(result.value.burning, false); assert.equal(result.value.progress, 0);
  }
  assert.equal(f.calls.includes("input"), false); assert.equal(f.calls.includes("output"), false);
  assert.equal(f.bot.currentWindow, null);
});

test("furnace cooks only the requested batch and confirms ingot gain over existing stock", async () => {
  const f = stationBot("furnace");
  f.inventory[0] = { item: "raw_iron", count: 3 }; f.inventory[1] = { item: "coal", count: 1 };
  f.inventory[2] = { item: "iron_ingot", count: 5 };
  const trace: string[] = [];
  const unsubscribe = subscribeTrace(name => trace.push(name));
  try {
    const result = await furnaceUse().execute(smelt, f.context);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) { assert.equal(result.value.collected, 3); assert.equal(result.value.inputInserted, 3); }
    assert.equal(f.inventory[2]?.count, 8);
    assert.equal(f.bot.currentWindow, null);
    assert.ok(trace.every(name => name === "station.operation"));
  } finally { unsubscribe(); }
});

test("occupied furnace, unsupported recipe and insufficient coal cause no insertions", async () => {
  const f = stationBot("furnace"); f.contents[2] = { item: "iron_ingot", count: 1 };
  assert.equal((await furnaceUse().execute(smelt, f.context)).ok, false);
  f.contents[2] = null; f.inventory[0] = { item: "raw_iron", count: 3 };
  assert.equal((await furnaceUse().execute(smelt, f.context)).ok, false);
  assert.equal((await furnaceUse().execute({ ...smelt, fuel: "stick" }, f.context)).ok, false);
  assert.equal(f.calls.includes("input"), false);
});

test("cancelling cooking retains partial facts and does not remove inserted items", async () => {
  const f = stationBot("furnace"); f.options.noCooking = true;
  f.inventory[0] = { item: "raw_iron", count: 3 }; f.inventory[1] = { item: "coal", count: 1 };
  const timer = setTimeout(() => f.abort.abort(), 30);
  const result = await furnaceUse().execute(smelt, f.context);
  clearTimeout(timer);
  assert.ok(!result.ok && result.error.code === "INTERRUPTED");
  if (!result.ok) { assert.equal(result.error.facts?.inputInserted, 3); assert.equal(result.error.facts?.collected, 0); }
  assert.equal(f.contents[0]?.count, 3);
  assert.equal(f.bot.currentWindow, null);
  assert.equal(f.calls.includes("output"), false);
});

test("a target or foreign window arriving during look is not opened or closed", async () => {
  for (const change of ["block", "window"] as const) {
    const f = stationBot(), foreign = {} as NonNullable<typeof f.bot.currentWindow>;
    f.bot.lookAt = async () => {
      if (change === "block") f.cells.clear();
      else { f.bot.currentWindow = foreign; f.client.emit("open_window", { windowId: 9 }); }
    };
    assert.equal((await chestRead().execute({}, f.context)).ok, false);
    assert.equal(f.calls.includes("open"), false);
    assert.equal(f.calls.includes("close"), false);
    assert.equal(f.bot.currentWindow, change === "window" ? foreign : null);
  }
});

test("disconnect during transfer cannot report success, retains uncertainty and cleans up listeners", async () => {
  const f = stationBot(); f.inventory[0] = { item: "oak_log", count: 4 };
  f.options.beforeTransfer = () => { f.bot.emit("end", "disconnected"); };
  const result = await chestUse().execute(deposit, f.context);
  assert.ok(!result.ok && result.error.code === "WORLD_CHANGED");
  if (!result.ok) assert.equal(result.error.facts?.inventoryKnown, false);
  assert.equal(f.client.listenerCount("window_items"), 0);
  assert.equal(f.bot.listenerCount("end"), 0);
  assert.equal(f.bot.currentWindow, null);
});

test("furnace output not actually collected is not success and is not retried", async () => {
  const f = stationBot("furnace");
  f.inventory[0] = { item: "raw_iron", count: 3 }; f.inventory[1] = { item: "coal", count: 1 };
  let attempts = 0;
  f.window.takeOutput = async () => { attempts++; f.emit(); };
  const result = await furnaceUse().execute(smelt, f.context);
  assert.ok(!result.ok && result.error.code === "ACTION_NOT_CONFIRMED");
  if (!result.ok) assert.equal(result.error.facts?.collected, 0);
  assert.equal(attempts, 1);
  assert.equal(f.contents[2]?.count, 3);
  assert.equal(f.bot.currentWindow, null);
});
