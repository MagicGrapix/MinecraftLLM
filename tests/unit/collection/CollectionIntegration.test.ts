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
import { terrainFixture } from "../../support/collectionTerrain";
import { CollectionTrace } from "../../../src/collection/CollectionTrace";
import { GotoCapability } from "../../../src/capabilities/Goto";
import { failure } from "../../../src/execution/TaskResult";
import { ToolCatalogBuilder, formatToolReference } from "../../../src/agent/ToolCatalogBuilder";
import { CoordinatorTools } from "../../../src/agent/CoordinatorTools";
import { WorldQueryRegistry } from "../../../src/world/queries/WorldQueryRegistry";
import { collectionScenes } from "../../fixtures/collection/scenes";

const data = mcData("1.21.11"), Block = blockLoader("1.21.11"), Item = itemLoader("1.21.11");
const position = new Vec3(3, 0, 0);
const block = (name: string, p = position) => {
  const b = Block.fromStateId(data.blocksByName[name]!.minStateId, 0); b.position = p; return b;
};
const item = (name: string, slot = 36) => { const i = new Item(data.itemsByName[name]!.id, 1); i.slot = slot; return i; };

test("collector is callable by actioner, documented to planner, and absent from coordinator tools", () => {
  const queries = new WorldQueryRegistry({} as never);
  const tools = new ToolCatalogBuilder(createCapabilityRegistry(), queries).build();
  const collect = tools.find(t => t.name === "collect_resource")!;
  assert.ok(collect); assert.match(collect.description, /24 supports/);
  assert.match(collect.description, /coal or raw_iron/);
  assert.match(collect.description, /stone_pickaxe/);
  assert.match(collect.description, /No tool crafting or smelting/);
  assert.match(formatToolReference(tools), /### collect_resource/);
  assert.ok(!new CoordinatorTools(queries).catalog().some(t => t.name === "collect_resource"));
});

test("collection regression scenes have unique bounded cells and explicit gain/stop oracles", () => {
  const origin = { x: -35, y: -60, z: -35 };
  const scenes = collectionScenes(origin);
  assert.deepEqual(scenes.map(s => s.name), ["hill", "hollow", "obstacle", "partial", "stop"]);
  for (const s of scenes) {
    assert.equal(new Set(s.blocks.map(b => JSON.stringify(b.position))).size, s.blocks.length);
    assert.ok(s.blocks.every(b => Math.hypot(b.position.x - origin.x, b.position.y - origin.y, b.position.z - origin.z) < 10));
    assert.equal(s.blocks.filter(b => b.name === "oak_log").length, s.stopDuringDig ? 1 : s.expectedGain);
  }
  assert.ok(scenes.find(s => s.name === "partial")!.requested > 2);
});

for (const requested of ["oak_log", "dirt"]) {
  test(`missing dirt reserve stops bounded access without spending requested ${requested}`, async t => {
    const f = terrainFixture();
    f.bot.blockAt = p => block(p.y < 0 ? "stone" : "air", p);
    Object.assign(f.bot, { world: { getColumn: () => ({}) } });
    Object.assign(f.bot.game, { minY: -64, height: 384 });
    const dirt = requested === "dirt" ? 3 : 0;
    const observation = { synchronize: async () => true, snapshot: { items: { dirt }, crafting: [], cursor: null }, capacity: () => 64 } as unknown as ServerInventoryConfirmation;
    const ops = new MineflayerCollectionOperations(f.context, observation);
    const resource = requested === "dirt" ? { item: "dirt", sources: ["grass_block", "dirt"] } : oakResource;
    ops.start(resource, 2, { x: 0, y: 0, z: 0 }, new CollectionTrace(), () => {});
    await ops.inventory(resource, f.controller.signal);
    const navigation = t.mock.method(GotoCapability.prototype, "execute", async () => failure("NO_PATH", "Fixture obstacle"));
    const result = await ops.move({ x: 3, y: 5, z: 0 }, "source", f.controller.signal);
    assert.ok(!result.ok && result.error.code === "MISSING_ITEM");
    assert.equal(navigation.mock.callCount(), 2, "No recursive collector or placement attempt without reserve");
    assert.equal(observation.snapshot!.items.dirt, dirt);
    assert.equal(f.digs(), 0); ops.dispose(); f.terrain.dispose();
  });
}

test("collector schema is strict and the physical registry exposes its long-running contract", () => {
  const cap = new CollectResourceCapability();
  for (const input of [{ item: "oak_log", quantity: 0 }, { item: "oak_log", quantity: 257 }, { item: "oak_log", quantity: "4" },
    { item: "oak_log", quantity: 1.5 }, { item: "oak_log", quantity: 4, radius: 1000 }]) assert.equal(cap.inputSchema.safeParse(input).success, false);
  assert.ok(cap.inputSchema.safeParse({ item: "oak_log", quantity: 256 }).success);
  const registered = createCapabilityRegistry().get("collect_resource")!;
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
  for (const [name, sources] of [
    ["coal", ["coal_ore", "deepslate_coal_ore"]],
    ["raw_iron", ["iron_ore", "deepslate_iron_ore"]],
  ] as const) {
    const resource = resolveResource(name, registry); assert.ok(resource.ok);
    assert.deepEqual(resource.value, { item: name, sources });
    assert.ok(new CollectResourceCapability().inputSchema.safeParse({ item: name, quantity: 3 }).success);
    const limitedRegistry = { ...registry, blocksByName: { [sources[0]]: data.blocksByName[sources[0]] } } as Bot["registry"];
    const partial = resolveResource(name, limitedRegistry); assert.ok(partial.ok);
    assert.deepEqual(partial.value.sources, [sources[0]], "Only source IDs in the connected registry are used");
  }
  for (const name of ["iron_ore", "deepslate_iron_ore", "iron_ingot", "coal_ore"]) {
    const unsupported = resolveResource(name, registry);
    assert.ok(!unsupported.ok && unsupported.error.code === "INVALID_ARGUMENT");
    assert.ok((unsupported.error.facts?.supported as string[]).includes("raw_iron"));
  }
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

for (const [name, drop] of [
  ["coal_ore", "coal"], ["deepslate_coal_ore", "coal"],
  ["iron_ore", "raw_iron"], ["deepslate_iron_ore", "raw_iron"],
]) test(`${name} needs the right pickaxe and must yield ${drop}, not a Silk Touch block`, () => {
  const ore = block(name!), resource = resolveResource(drop!, data as unknown as Bot["registry"]);
  assert.ok(resource.ok);
  assert.equal(canHarvestResource(ore, null, resource.value), false);
  assert.equal(canHarvestResource(ore, item("wooden_axe"), resource.value), false);
  for (const name of ["wooden_pickaxe", "golden_pickaxe"]) {
    assert.equal(canHarvestResource(ore, item(name), resource.value), drop === "coal", name);
  }
  for (const name of ["copper_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"]) {
    assert.equal(canHarvestResource(ore, item(name), resource.value), true, name);
  }
  const silk = item("diamond_pickaxe"); silk.enchants = [{ name: "silk_touch", lvl: 1 }];
  assert.equal(canHarvestResource(ore, silk, resource.value), false);
  const fortune = item("diamond_pickaxe"); fortune.enchants = [{ name: "fortune", lvl: 3 }];
  assert.equal(canHarvestResource(ore, fortune, resource.value), true);
});

test("ore extraction selects a valid inventory pickaxe and rechecks the held tool before digging", async () => {
  const f = terrainFixture(), p = new Vec3(3, 0, 0);
  f.set(p, "iron_ore");
  const wooden = item("wooden_pickaxe", 36), stone = item("stone_pickaxe", 37);
  const silk = item("diamond_pickaxe", 38); silk.enchants = [{ name: "silk_touch", lvl: 1 }];
  const broken = item("iron_pickaxe", 39); broken.durabilityUsed = broken.maxDurability;
  let tools = [wooden, silk, broken, stone], equipped = 0;
  Object.assign(f.bot, { heldItem: wooden, inventory: { items: () => tools },
    equip: async (tool: unknown) => { equipped++; Object.assign(f.bot, { heldItem: tool }); } });
  const resource = resolveResource("raw_iron", f.bot.registry); assert.ok(resource.ok);
  const target = f.read(p)!;
  const source = { name: target.name, stateId: target.stateId, position: p };
  const ops = new MineflayerCollectionOperations(f.context, {} as ServerInventoryConfirmation);
  try {
    const selected = inspectHarvest(f.bot, source, resource.value);
    assert.ok(selected.ok); assert.equal(selected.value.tool, stone);
    const wrongHand = await ops.dig(source, resource.value, f.controller.signal);
    assert.ok(!wrongHand.ok && wrongHand.error.code === "MISSING_ITEM");
    assert.equal(f.digs(), 0);
    assert.ok((await ops.equip(source, resource.value, f.controller.signal)).ok);
    assert.equal(equipped, 1); assert.equal(f.bot.heldItem, stone);
    // Exhausted or Silk Touch tools must not become a destructive fallback.
    tools = [wooden, silk, broken]; Object.assign(f.bot, { heldItem: wooden });
    const missing = await ops.equip(source, resource.value, f.controller.signal);
    assert.ok(!missing.ok && missing.error.code === "MISSING_ITEM");
    assert.equal(equipped, 1); assert.equal(f.digs(), 0);
    tools = [stone];
    assert.ok((await ops.equip(source, resource.value, f.controller.signal)).ok);
    assert.ok((await ops.dig(source, resource.value, f.controller.signal)).ok);
    assert.equal(f.digs(), 1); assert.equal(f.read(p)!.name, "air");
  } finally { f.terrain.dispose(); }
});

test("ore pickup filters by the requested dropped item, not source block items or ingots", () => {
  const f = terrainFixture();
  const entities = ["raw_iron", "iron_ore", "iron_ingot", "coal", "coal_ore"].map((name, i) => ({
    id: i + 1, position: { x: 3, y: 0, z: 0 }, droppedItem: { name, count: 2 },
  }));
  Object.assign(f.context.world, { getNearbyEntities: () => entities });
  const ops = new MineflayerCollectionOperations(f.context, {} as ServerInventoryConfirmation);
  try {
    for (const [name, id] of [["raw_iron", 1], ["coal", 4]] as const) {
      const resource = resolveResource(name, f.bot.registry); assert.ok(resource.ok);
      assert.deepEqual(ops.drops(resource.value, { x: 0, y: 0, z: 0 }).map(d => d.id), [id]);
    }
  } finally { f.terrain.dispose(); }
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
