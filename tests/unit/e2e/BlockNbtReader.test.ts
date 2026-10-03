import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { BlockNbtReader, chestInventory } from "../../e2e/BlockNbtReader";

const stack = (id: string, count?: number) => ({ id: { type: "string", value: id }, ...(count === undefined ? {} : { count: { type: "int", value: count } }) });
const chest = (items: unknown[]) => ({ type: "compound", value: { id: { type: "string", value: "minecraft:chest" }, Items: { type: "list", value: { type: "compound", value: items } } } });

test("chest NBT counts actual item stacks, including count=1 default and empty chests", () => {
  assert.deepEqual(chestInventory(chest([stack("minecraft:oak_log", 2), stack("minecraft:oak_log", 2), stack("minecraft:stick")])), { oak_log: 4, stick: 1 });
  assert.deepEqual(chestInventory(chest([])), {});
  assert.equal(chestInventory(null), null);
  assert.equal(chestInventory({ type: "compound", value: {} }), null);
  assert.equal(chestInventory(chest([stack("minecraft:oak_log", -1)])), null);
  assert.equal(chestInventory(chest([{}])), null);
  assert.equal(chestInventory({ ...chest([]), value: { ...chest([]).value, id: { type: "string", value: "minecraft:furnace" } } }), null);
});

function client() {
  const events = new EventEmitter();
  const writes: { name: string; data: any }[] = [];
  const raw = Object.assign(events, { write: (name: string, data: any) => writes.push({ name, data }) });
  return { events, writes, raw: raw as unknown as Bot["_client"] };
}

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
