import "../../src/Logger";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { simplify, type NBT } from "prismarine-nbt";
import { Vec3 } from "vec3";
import { MINECRAFT_VERSION } from "../../src/config";
import { getFullTraceFilePath } from "../../src/Logger";
import { writeTrace } from "../../src/TraceLog";
import { CraftFromInventoryCapability, CraftFromTableCapability } from "../../src/capabilities/Craft";
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
import { bounded, until } from "../../tests/e2e/async";
import { entityNbt } from "../../tests/support/entityNbt";

/** Explicit survival smoke, no LLM; only this test player's inventory and one empty fixture cell are changed. */
async function main() {
  const username = "craft_test_bot";
  const config = loadWorldBuilderConfig({ ...process.env, WORLD_CONTROLLER_USERNAME: "test_controller", WORLD_AGENT_USERNAME: username });
  const table = new Vec3(-35, -60, -35);
  assert.ok(containsPosition(config.arena, table));
  const controller = new WorldControllerRuntime(config);
  const runtime = new MinecraftRuntime({ host: config.host, port: config.port, username, auth: "offline", version: MINECRAFT_VERSION });
  let transport: MineflayerCommandTransport | undefined;
  let executor: Executor | undefined;
  let ownsTable = false;
  let transaction = 0;
  const command = async (text: string) => {
    await delay(1100);
    const response = await transport!.send(text);
    if (response.error) throw new Error(response.error);
  };
  const readInventory = async () => {
    const entity = controller.bot.players[username]?.entity;
    assert.ok(entity, "Test player not visible to controller");
    const raw = await entityNbt(controller.bot, entity.id, ++transaction);
    const data = simplify(raw as NBT) as { Inventory?: Array<{ id: string; count?: number; Slot: number }> };
    assert.ok(Array.isArray(data.Inventory), "Controller inventory observation is unknown");
    const inventory: Record<string, number> = {};
    for (const item of data.Inventory) {
      assert.equal(typeof item.id, "string");
      const name = item.id.replace(/^minecraft:/, "");
      const count = item.count ?? 1;
      assert.ok(Number.isSafeInteger(count) && count > 0);
      inventory[name] = (inventory[name] ?? 0) + count;
    }
    return inventory;
  };
  try {
    await bounded(controller.connect(), 15_000, "Controller connection");
    assert.ok(!controller.bot.players[username], "Craft smoke player already connected");
    transport = new MineflayerCommandTransport(controller.bot, 300);
    await controller.initialize(transport);
    assert.equal(controller.bot.blockAt(table)?.name, "air", "Refusing occupied or unloaded fixture");
    assert.equal(controller.bot.blockAt(table.offset(0, -1, 0))?.name, "grass_block", "Expected flat grass support");
    await bounded(runtime.connect(), 15_000, "Craft bot connection");
    await command(`gamemode survival ${username}`);
    await command(`tp ${username} -34.5 -60 -36.5`);
    await until(() => runtime.bot.entity.onGround && runtime.bot.entity.position.distanceTo(table) < 3, 5000, "Test bot arrival");
    ownsTable = true;
    await command(`setblock ${table.x} ${table.y} ${table.z} crafting_table`);
    await until(() => runtime.bot.blockAt(table)?.name === "crafting_table", 3000, "Table propagation");
    await command(`clear ${username}`);
    await command(`give ${username} oak_log 20`);
    await until(() => snapshotInventory(runtime.bot).oak_log === 20, 3000, "Initial stock");
    assert.deepEqual(await readInventory(), { oak_log: 20 });
    const registry = new CapabilityRegistry();
    registry.register(new CraftFromInventoryCapability()); registry.register(new CraftFromTableCapability()); registry.freeze();
    executor = new Executor({ runtime, registry, world: new MineflayerWorldQueries(runtime) });
    const tasks = new TaskFactory();
    const craft = async (item: string, quantity: number, expected: Record<string, number>, atTable = false) => {
      const result = await executor!.execute(tasks.create({
        capability: atTable ? "craft_from_table_3x3" : "craft_from_inventory_2x2",
        input: { item, quantity, ...(atTable ? { tablePosition: { x: table.x, y: table.y, z: table.z } } : {}) },
      }));
      const inventory = await readInventory();
      writeTrace("craft.smoke", { item, quantity, atTable, result, inventory });
      console.info("Craft smoke", { item, quantity, atTable, result, inventory });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(inventory, expected, "Independent server inventory differs");
      assert.deepEqual(snapshotInventory(runtime.bot), expected, "Client differs from independent inventory");
      assert.equal(runtime.bot.inventory.selectedItem, null, "Cursor not empty");
      assert.ok(runtime.bot.inventory.slots.slice(0, 5).every(slot => slot === null), "Crafting grid not empty");
    };
    await craft("oak_planks", 7, { oak_log: 18, oak_planks: 8 });
    await craft("oak_planks", 64, { oak_log: 2, oak_planks: 72 });
    await craft("oak_planks", 7, { oak_planks: 80 });
    await craft("crafting_table", 1, { oak_planks: 76, crafting_table: 1 });
    await craft("stick", 1, { oak_planks: 74, crafting_table: 1, stick: 4 });
    await craft("wooden_pickaxe", 1, { oak_planks: 71, crafting_table: 1, stick: 2, wooden_pickaxe: 1 }, true);
    await craft("stick", 1, { oak_planks: 69, crafting_table: 1, stick: 6, wooden_pickaxe: 1 }, true);
    console.info("Craft smoke passed: 7/64/7 planks, inventory recipes and table recipes. No unexpected items. No LLM.");
  } finally {
    executor?.abortCurrent("Craft smoke cleanup");
    await cleanupSteps([
      { name: "settlement", run: () => executor?.waitForIdle(10_000) },
      { name: "test inventory", run: async () => { if (runtime.isConnected && transport) await command(`clear ${username}`); } },
      { name: "bot", run: () => runtime.disconnect("Craft smoke finished") },
      { name: "fixture", run: async () => {
        if (ownsTable && controller.bot.blockAt(table)?.name === "crafting_table") {
          await command(`setblock ${table.x} ${table.y} ${table.z} air`);
          await until(() => controller.bot.blockAt(table)?.name === "air", 3000, "Fixture removed");
        }
      } },
      { name: "transport", run: () => transport?.close() },
      { name: "controller", run: () => controller.disconnect() },
    ]);
    console.info("Trace:", getFullTraceFilePath());
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
