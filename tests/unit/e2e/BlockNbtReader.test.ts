import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { BlockNbtReader, chestInventory, furnaceInventory } from "../../e2e/BlockNbtReader";

const stack = (id: string, count?: number) => ({ id: { type: "string", value: id }, ...(count === undefined ? {} : { count: { type: "int", value: count } }) });
const chest = (items: unknown[]) => ({ type: "compound", value: { id: { type: "string", value: "minecraft:chest" }, Items: { type: "list", value: { type: "compound", value: items } } } });

test("furnace NBT requires furnace identity and unique slots 0..2, never chest data", () => {
  const item = { ...stack("minecraft:iron_ingot", 3), Slot: { type: "byte", value: 2 } };
  const nbt = (items: unknown[]) => ({ type: "compound", value: { Items: { type: "list", value: { type: "compound", value: items } } } });
  assert.deepEqual(furnaceInventory(nbt([item]), "furnace"), { ok: true, inventory: { iron_ingot: 3 } });
  assert.deepEqual(furnaceInventory(nbt([]), "furnace"), { ok: true, inventory: {} });
  for (const raw of [null, chest([]), nbt([item, item]), nbt([{ ...item, Slot: { type: "byte", value: 3 } }]),
    nbt([{ ...item, count: { type: "int", value: -1 } }]), { type: "compound", value: {} }]) {
    assert.equal(furnaceInventory(raw, "furnace").ok, false);
  }
  assert.equal(furnaceInventory(nbt([]), "chest").ok, false);
  assert.equal(chestInventory(nbt([]), "furnace").ok, false);
});

test("chest NBT counts actual item stacks, including count=1 default and empty chests", () => {
  assert.deepEqual(chestInventory(chest([stack("minecraft:oak_log", 2), stack("minecraft:oak_log", 2), stack("minecraft:stick")])), { ok: true, inventory: { oak_log: 4, stick: 1 } });
  assert.deepEqual(chestInventory(chest([])), { ok: true, inventory: {} });
  for (const raw of [null, { type: "compound", value: {} }, chest([stack("minecraft:oak_log", -1)]), chest([{}]),
    { ...chest([]), value: { ...chest([]).value, id: { type: "string", value: "minecraft:furnace" } } }]) {
    const result = chestInventory(raw);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, "INVALID_CHEST_NBT"); assert.ok(result.error.path); assert.ok(result.error.sample!.length <= 2000); }
  }
});

function client() {
  const events = new EventEmitter();
  const writes: { name: string; data: any }[] = [];
  const raw = Object.assign(events, { write: (name: string, data: any) => writes.push({ name, data }) });
  return { events, writes, raw: raw as unknown as Bot["_client"] };
}

test("Java 1.21.11 metadata-free NBT requires independently observed chest identity", () => {
  // Actual packet shape captured from the local 1.21.11 server.
  const empty = { type: "compound", value: { components: { type: "compound", value: {} }, Items: { type: "list", value: { type: "end", value: [] } } } };
  assert.deepEqual(chestInventory(empty, "chest"), { ok: true, inventory: {} });
  assert.equal(chestInventory(empty).ok, false);
  assert.equal(chestInventory(empty, "furnace").ok, false);
  assert.equal(chestInventory({ type: "compound", value: {} }, "chest").ok, false);
  const populated = { type: "compound", value: { Items: { type: "list", value: { type: "compound", value: [stack("minecraft:oak_log", 2)] } } } };
  assert.deepEqual(chestInventory(populated, "chest"), { ok: true, inventory: { oak_log: 2 } });
});

test("NBT observer matches transaction ids and cleans up listeners without chat/window actions", async () => {
  const c = client(), reader = new BlockNbtReader(c.raw);
  const position = { x: 3, y: -60, z: 0 };
  const pending = reader.read(position);
  assert.deepEqual(c.writes, [{ name: "query_block_nbt", data: { transactionId: 1, location: position } }]);
  c.events.emit("nbt_query_response", { transactionId: 999, nbt: "wrong reply" });
  c.events.emit("nbt_query_response", { transactionId: 1, nbt: chest([]) });
  assert.deepEqual(await pending, chest([]));
  assert.equal(c.events.listenerCount("nbt_query_response"), 0);
  assert.equal(c.events.listenerCount("end"), 0);
  const second = reader.read(position);
  c.events.emit("nbt_query_response", { transactionId: 2, nbt: null });
  assert.equal(await second, null);
});

test("NBT timeout, disconnect and write errors cannot become an empty chest", async () => {
  const c = client(), reader = new BlockNbtReader(c.raw, 10);
  await assert.rejects(reader.read({ x: 0, y: 0, z: 0 }), /timed out/);
  assert.equal(c.events.listenerCount("nbt_query_response"), 0);
  const pending = reader.read({ x: 0, y: 0, z: 0 });
  c.events.emit("end");
  await assert.rejects(pending, /disconnected/);
  c.raw.write = () => { throw new Error("write failed"); };
  await assert.rejects(reader.read({ x: 0, y: 0, z: 0 }), /write failed/);
  assert.equal(c.events.listenerCount("end"), 0);
});
