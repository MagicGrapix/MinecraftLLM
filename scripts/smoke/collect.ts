import "../../src/Logger";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { simplify, type NBT } from "prismarine-nbt";
import { Vec3 } from "vec3";
import { MINECRAFT_VERSION } from "../../src/config";
import { getFullTraceFilePath } from "../../src/Logger";
import { subscribeTrace, writeTrace } from "../../src/TraceLog";
import { CollectResourceCapability } from "../../src/capabilities/CollectResource";
import { CapabilityRegistry } from "../../src/capabilities/CapabilityRegistry";
import { Executor } from "../../src/execution/Executor";
import { TaskFactory } from "../../src/execution/TaskFactory";
import { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import { snapshotInventory } from "../../src/runtime/InventoryAdapter";
import { cleanupSteps } from "../../src/runtime/cleanup";
import { MineflayerWorldQueries } from "../../src/world/MineflayerWorldQueries";
import { WorldControllerRuntime } from "../../src/devworld/controller/WorldControllerRuntime";
import { MineflayerCommandTransport } from "../../src/devworld/controller/MineflayerCommandTransport";
import { loadWorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { containsPosition } from "../../src/devworld/ArenaBounds";
import { blockPositionKey } from "../../src/world/BlockSearch";
import { bounded, until } from "../../tests/e2e/async";
import { entityNbt } from "../../tests/support/entityNbt";
import type { Position } from "../../src/shared/types";

/** Explicit no-LLM survival test. Never resets the arena or the main player's inventory. */
async function main() {
  const username = "collect_test_bot";
  const terrain = process.argv.includes("--terrain");
  const config = loadWorldBuilderConfig({ ...process.env, WORLD_CONTROLLER_USERNAME: "test_controller", WORLD_AGENT_USERNAME: username });
  const origin = new Vec3(-35, -60, -35);
  const wood = [0, 1, 2, 3].map(y => origin.offset(3, y, 0));
  const stones = [0, 1].map(z => origin.offset(4, 0, z));
  const fixtures = [...wood, ...stones];
  assert.ok(fixtures.every(p => containsPosition(config.arena, p)));
  const controller = new WorldControllerRuntime(config);
  const runtime = new MinecraftRuntime({ host: config.host, port: config.port, username, auth: "offline", version: MINECRAFT_VERSION });
  let transport: MineflayerCommandTransport | undefined, executor: Executor | undefined, transaction = 0;
  const restore = new Map<string, { position: Position; name: string }>();
  const minedPositions: Position[] = [];
  let initialEntities = new Set<number>();
  let unsubscribe = () => {};
  const command = async (text: string) => {
    await delay(1100); const response = await transport!.send(text);
    if (response.error) throw new Error(response.error);
  };
  const inventory = async () => {
    const entity = controller.bot.players[username]?.entity; assert.ok(entity);
    const raw = await entityNbt(controller.bot, entity.id, ++transaction);
    const data = simplify(raw as NBT) as { Inventory?: { id: string; count?: number }[] };
    assert.ok(Array.isArray(data.Inventory));
    const counts: Record<string, number> = {};
    for (const item of data.Inventory) {
      const name = item.id.replace(/^minecraft:/, ""); counts[name] = (counts[name] ?? 0) + (item.count ?? 1);
    }
    return counts;
  };
  try {
    await bounded(controller.connect(), 15_000, "Controller connection");
    assert.ok(!controller.bot.players[username], "Collection test bot already online");
    transport = new MineflayerCommandTransport(controller.bot, 300); await controller.initialize(transport);
    for (const p of fixtures) assert.equal(controller.bot.blockAt(p)?.name, "air", "Refusing occupied or unloaded fixture");
    for (const p of [wood[0]!, ...stones]) {
      const support = p.offset(0, -1, 0);
      const block = controller.bot.blockAt(support); assert.ok(block);
      restore.set(blockPositionKey(support), { position: support, name: block.name });
    }
    await bounded(runtime.connect(), 15_000, "Collection bot connection");
    await command(`gamemode survival ${username}`);
    await command(`tp ${username} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`);
    await command(`clear ${username}`); await command(`give ${username} oak_log 1`);
    for (const p of fixtures) {
      restore.set(blockPositionKey(p), { position: p, name: "air" });
      await command(`setblock ${p.x} ${p.y} ${p.z} ${wood.includes(p) ? "oak_log" : "stone"}`);
    }
    await until(() => runtime.bot.entity.onGround && snapshotInventory(runtime.bot).oak_log === 1 && fixtures.every(p => runtime.bot.blockAt(p)?.boundingBox === "block"), 5000, "Fixture propagation");
    const world = new MineflayerWorldQueries(runtime);
    assert.equal(world.getNearbyEntities().some(e => e.droppedItem && ["oak_log", "cobblestone", "dirt"].includes(e.droppedItem.name)), false,
      "Pre-existing resource drops would contaminate this fixture; refusing test");
    initialEntities = new Set(Object.values(controller.bot.entities).map(e => e.id));
    assert.deepEqual((await world.findNearestBlocks("oak_log", { count: 4 })).map(b => blockPositionKey(b.position)).sort(), wood.map(blockPositionKey).sort(), "Unexpected closer wood; refusing uncontrolled test");
    assert.deepEqual((await world.findNearestBlocks("stone", { count: 2 })).map(b => blockPositionKey(b.position)).sort(), stones.map(blockPositionKey).sort(), "Unexpected closer stone; refusing uncontrolled test");
    const registry = new CapabilityRegistry(); registry.register(new CollectResourceCapability()); registry.freeze();
    executor = new Executor({ runtime, world, registry }); const tasks = new TaskFactory();
    unsubscribe = subscribeTrace((event, raw) => {
      if (event !== "collect.event") return;
      const e = raw as { event: string; operation: string; args: { position: Position; block: string } };
      if (e.event !== "operation_started" || !["dig", "reserve_dig", "path_dig", "scaffold_place"].includes(e.operation)) return;
      const p = e.args.position;
      if (e.operation !== "scaffold_place") minedPositions.push({ ...p });
      if (!restore.has(blockPositionKey(p))) {
        const block = controller.bot.blockAt(new Vec3(p.x, p.y, p.z)); assert.ok(block);
        restore.set(blockPositionKey(p), { position: p, name: block.name });
      }
    });
    const collect = async (item: string, quantity: number) => {
      const result = await executor!.execute(tasks.create({ capability: "collect_resource", input: { item, quantity }, timeoutMs: 120_000 }));
      const stock = await inventory(); writeTrace("collect.smoke", { item, quantity, result, stock });
      console.info("Collect smoke", { item, quantity, result, stock }); return { result, stock };
    };
    const logs = await collect("oak_log", 4); assert.ok(logs.result.ok, JSON.stringify(logs.result)); assert.equal(logs.stock.oak_log, 5);
    assert.ok(wood.every(p => controller.bot.blockAt(p)?.name === "air"));
    const missing = await collect("cobblestone", 2); assert.ok(!missing.result.ok && missing.result.error.code === "MISSING_ITEM");
    assert.ok(stones.every(p => controller.bot.blockAt(p)?.name === "stone"));
    await command(`give ${username} wooden_pickaxe 1`);
    await until(() => snapshotInventory(runtime.bot).wooden_pickaxe === 1, 3000, "Pickaxe arrival");
    const mined = await collect("cobblestone", 2); assert.ok(mined.result.ok, JSON.stringify(mined.result)); assert.equal(mined.stock.cobblestone, 2);
    const initialDirt = (await inventory()).dirt ?? 0;
    const dirt = await collect("dirt", 2); assert.ok(dirt.result.ok, JSON.stringify(dirt.result)); assert.equal(dirt.stock.dirt, initialDirt + 2);
    if (terrain) {
      const high = origin.offset(3, 7, 0);
      assert.equal(controller.bot.blockAt(high)?.name, "air");
      restore.set(blockPositionKey(high), { position: high, name: "air" });
      for (const supplied of [true, false]) {
        await command(`tp ${username} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`);
        await command(`clear ${username} dirt`);
        if (supplied) await command(`give ${username} dirt 8`);
        await command(`setblock ${high.x} ${high.y} ${high.z} oak_log`);
        await until(() => runtime.bot.blockAt(high)?.name === "oak_log" && runtime.bot.entity.onGround, 3000, "High log fixture");
        const before = (await inventory()).oak_log ?? 0;
        const result = await collect("oak_log", 1);
        assert.ok(result.result.ok, JSON.stringify(result)); assert.equal(result.stock.oak_log, before + 1);
        assert.equal(controller.bot.blockAt(high)?.name, "air");
        console.info("Terrain collection passed", { suppliedDirt: supplied, result: result.result });
      }
    }
    console.info("Collect smoke passed: 1+4 logs, missing pickaxe without mining, 2 cobblestone from stone, 2 dirt. Independent server inventory; no LLM.");
  } finally {
    executor?.abortCurrent("Collection smoke cleanup");
    await cleanupSteps([
      { name: "physical settlement", run: () => executor?.waitForIdle(10_000) },
      { name: "test inventory", run: async () => { if (runtime.isConnected && transport) await command(`clear ${username}`); } },
      { name: "bot", run: () => runtime.disconnect("Collection smoke finished") },
      { name: "remaining test drops", run: async () => {
        if (!transport) return;
        for (const e of Object.values(controller.bot.entities)) {
          if (initialEntities.has(e.id) || e.name !== "item" || !e.uuid ||
              !minedPositions.some(p => e.position.distanceTo(new Vec3(p.x, p.y, p.z)) < 3)) continue;
          const item = e.getDroppedItem();
          if (item && ["oak_log", "cobblestone", "dirt"].includes(item.name)) await command(`kill ${e.uuid}`);
        }
      } },
      { name: "fixtures", run: async () => {
        for (const { position: p, name } of [...restore.values()].sort((a, b) => a.position.y - b.position.y)) {
          assert.ok(containsPosition(config.arena, p), "Refusing cleanup outside arena");
          if (controller.bot.blockAt(new Vec3(p.x, p.y, p.z))?.name === name) continue;
          await command(`setblock ${p.x} ${p.y} ${p.z} ${name}`);
        }
        await until(() => [...restore.values()].every(v => controller.bot.blockAt(new Vec3(v.position.x, v.position.y, v.position.z))?.name === v.name), 5000, "Fixture restoration");
      } },
      { name: "trace observer", run: () => unsubscribe() },
      { name: "transport", run: () => transport?.close() },
      { name: "controller", run: () => controller.disconnect() },
    ], 60_000);
    console.info("Trace:", getFullTraceFilePath());
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
