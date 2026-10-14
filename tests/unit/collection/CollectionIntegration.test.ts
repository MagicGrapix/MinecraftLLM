import assert from "node:assert/strict";
import test from "node:test";
import mcData from "minecraft-data";
import blockLoader from "prismarine-block";
import itemLoader from "prismarine-item";
import type { Bot } from "mineflayer";
import type { ExecutionContext } from "../../../src/capabilities/Capability";
import { Vec3 } from "vec3";
import { CollectResourceCapability } from "../../../src/capabilities/CollectResource";
import { resolveResource } from "../../../src/collection/ResourceCatalog";
import { canHarvestResource, inspectHarvest } from "../../../src/collection/ResourceAccess";
import { pickupPosition } from "../../../src/collection/ResourcePickup";
import { MineflayerCollectionOperations } from "../../../src/collection/MineflayerCollectionOperations";
import { ServerInventoryConfirmation } from "../../../src/runtime/ServerInventoryConfirmation";
import { createCapabilityRegistry } from "../../../src/bootstrap/createCapabilities";
import { fakeCraftBot } from "../../support/CraftBot";
import { oakResource } from "../../support/collection";

const data = mcData("1.21.11"), Block = blockLoader("1.21.11"), Item = itemLoader("1.21.11");
const position = new Vec3(3, 0, 0);
const block = (name: string, p = position) => {
  const b = Block.fromStateId(data.blocksByName[name]!.minStateId, 0); b.position = p; return b;
};
const item = (name: string, slot = 36) => { const i = new Item(data.itemsByName[name]!.id, 1); i.slot = slot; return i; };

test("collector schema is strict and the physical registry exposes its long-running contract", () => {
  const cap = new CollectResourceCapability();
  for (const input of [{ item: "oak_log", quantity: 0 }, { item: "oak_log", quantity: 257 }, { item: "oak_log", quantity: "4" },
    { item: "oak_log", quantity: 1.5 }, { item: "oak_log", quantity: 4, radius: 1000 }]) assert.equal(cap.inputSchema.safeParse(input).success, false);
  assert.ok(cap.inputSchema.safeParse({ item: "oak_log", quantity: 256 }).success);
  const registered = createCapabilityRegistry({} as never).get("collect_resource")!;
  assert.equal(registered.defaultTimeoutMs, 300_000);
  assert.match(registered.description!, /additional|Additional/);
});

test("catalog differentiates unknown items, unsupported resources and source-to-drop mappings", () => {
  const registry = data as unknown as Bot["registry"];
  for (const name of ["oak_plate", "diamond", "constructor", "__proto__"]) assert.ok(!resolveResource(name, registry).ok);
  const dirt = resolveResource("minecraft:dirt", registry); assert.ok(dirt.ok);
  assert.deepEqual(dirt.value.sources, ["dirt", "grass_block"]);
  const stone = resolveResource("cobblestone", registry); assert.ok(stone.ok);
  assert.deepEqual(stone.value.sources, ["stone", "cobblestone"]);
});

test("unsupported resource is rejected before the capability accesses the world or sends anything", async () => {
  const context = { runtime: { bot: { registry: data } }, signal: new AbortController().signal } as unknown as ExecutionContext;
  const result = await new CollectResourceCapability().execute({ item: "diamond", quantity: 4 }, context);
  assert.ok(!result.ok && result.error.code === "INVALID_ARGUMENT");
});

test("stone requires a harvest-capable pickaxe and excludes Silk Touch for cobblestone", () => {
  const stone = block("stone"), resource = { item: "cobblestone", sources: ["stone", "cobblestone"] };
  assert.equal(canHarvestResource(stone, null, resource), false);
  assert.equal(canHarvestResource(stone, item("wooden_axe"), resource), false);
  assert.equal(canHarvestResource(stone, item("wooden_pickaxe"), resource), true);
  const silk = item("diamond_pickaxe"); silk.enchants = [{ name: "silk_touch", lvl: 1 }];
  assert.equal(canHarvestResource(stone, silk, resource), false);
  assert.equal(canHarvestResource(block("cobblestone"), silk, resource), true);
  assert.equal(canHarvestResource(block("grass_block"), silk, { item: "dirt", sources: ["grass_block"] }), false);
});

test("harvest preflight checks tool durability, target identity, support and the bot's footing", () => {
  let target = block("stone"), support: ReturnType<typeof block> | null = block("dirt", position.offset(0, -1, 0));
  let tools = [item("wooden_pickaxe")];
  const bot = { entity: { position: new Vec3(0.5, 0, 0.5) }, registry: data, heldItem: null,
    inventory: { items: () => tools }, blockAt: (p: Vec3) => p.equals(position) ? target : support } as unknown as Bot;
  const source = { name: "stone", stateId: target.stateId, position };
  const resource = { item: "cobblestone", sources: ["stone"] };
  assert.ok(inspectHarvest(bot, source, resource).ok);
  tools = []; const missing = inspectHarvest(bot, source, resource); assert.ok(!missing.ok && missing.error.code === "MISSING_ITEM");
  tools = [item("wooden_pickaxe")]; tools[0]!.durabilityUsed = tools[0]!.maxDurability;
  assert.ok(!inspectHarvest(bot, source, resource).ok);
  tools = [item("wooden_pickaxe")]; support = null;
  assert.ok(!inspectHarvest(bot, source, resource).ok);
  support = block("dirt"); bot.entity.position = position.offset(0.5, 1, 0.5);
  assert.ok(!inspectHarvest(bot, source, resource).ok);
  bot.entity.position = new Vec3(0.5, 0, 0.5); target = block("dirt");
  assert.ok(!inspectHarvest(bot, source, resource).ok);
});

test("floating upper tree logs remain harvestable without digging beneath the bot", () => {
  const p = new Vec3(3, 2, 0), log = block("oak_log", p);
  const bot = { entity: { position: new Vec3(0.5, 0, 0.5) }, registry: data, heldItem: null,
    inventory: { items: () => [] }, blockAt: (at: Vec3) => at.equals(p) ? log : block("air", at) } as unknown as Bot;
  assert.ok(inspectHarvest(bot, { name: log.name, stateId: log.stateId, position: p }, oakResource).ok);
});

test("falling drops target their landing surface rather than an unreachable air cell", () => {
  let ground: string | null = "grass_block";
  const bot = { blockAt: (p: Vec3) => ground === null ? null : block(p.y === -61 ? ground : "air", p) } as unknown as Bot;
  assert.deepEqual(pickupPosition(bot, { x: -31.4, y: -57.2, z: -34.4 }), { x: -32, y: -60, z: -35 });
  assert.deepEqual(pickupPosition(bot, { x: -31.4, y: -59.9, z: -34.4 }), { x: -32, y: -60, z: -35 });
  assert.equal(pickupPosition(bot, { x: -31.4, y: -50, z: -34.4 }), null);
  ground = "water"; assert.equal(pickupPosition(bot, { x: -31.4, y: -60, z: -34.4 }), null);
  ground = null; assert.equal(pickupPosition(bot, { x: -31.4, y: -60, z: -34.4 }), null);
});

test("pickup chooses a reachable neighboring cell when a hanging log blocks the drop column", () => {
  const bot = { blockAt: (p: Vec3) => block(p.y === -61 ? "grass_block" :
    p.x === -32 && p.y === -59 && p.z === -35 ? "oak_log" : "air", p) } as unknown as Bot;
  const target = pickupPosition(bot, { x: -31.125, y: -60, z: -34.85 });
  assert.ok(target); assert.equal(target.y, -60);
  assert.notDeepEqual(target, { x: -32, y: -60, z: -35 });
  assert.ok(Math.hypot(target.x + 0.5 + 31.125, target.z + 0.5 + 34.85) <= 1.15);
});

test("collector inventory uses server counts, not optimistic local inventory, and keeps capacity", async () => {
  const bot = fakeCraftBot({ counts: id => id === 17 ? 9 : 0, serverCounts: id => id === 17 ? 1 : 0, recipes: [], craft: async () => {} });
  bot.registry.itemsByName.oak_log!.stackSize = 64;
  const observation = new ServerInventoryConfirmation(bot, { pollIntervalMs: 1, timeoutMs: 30 });
  const context = { runtime: { bot }, signal: new AbortController().signal } as unknown as ExecutionContext;
  try {
    const result = await new MineflayerCollectionOperations(context, observation).inventory(oakResource, context.signal);
    assert.ok(result.ok); assert.equal(result.value.count, 1); assert.equal(result.value.capacity, 36 * 64 - 1);
    bot.emit("end", "test");
    assert.equal(observation.capacity("oak_log", 64), null);
  } finally { observation.dispose(); }
});

for (const interruption of ["stop", "end", "death", "respawn", "bounds"] as const) {
  test(`collection ${interruption} during initial confirmation releases its observation listeners`, async () => {
    let entered!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const bot = fakeCraftBot({ counts: () => 0, recipes: [], craft: async () => {}, sync: () => entered() });
    bot.entity.position = new Vec3(0, 0, 0);
    Object.assign(bot, { game: { dimension: "overworld" } });
    Object.assign(bot.registry, { blocksByName: data.blocksByName });
    const controller = new AbortController();
    const context = { runtime: { bot }, signal: controller.signal } as unknown as ExecutionContext;
    const pending = new CollectResourceCapability().execute({ item: "oak_log", quantity: 1 }, context);
    await requested;
    if (interruption === "stop") controller.abort(new Error("Test stop"));
    else if (interruption === "bounds") { bot.entity.position.x = 51; bot.emit("physicsTick"); }
    else bot.emit(interruption as "death");
    if (interruption === "stop") await assert.rejects(pending, /Test stop/);
    else { const result = await pending; assert.ok(!result.ok && result.error.code === "WORLD_CHANGED"); }
    for (const name of ["end", "death", "respawn", "physicsTick"] as const) assert.equal(bot.listenerCount(name), 0);
    for (const name of ["window_items", "set_slot", "set_player_inventory", "set_cursor_item"]) assert.equal(bot._client.listenerCount(name), 0);
  });
}
