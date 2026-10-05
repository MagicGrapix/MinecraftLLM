import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { setTimeout as delay } from "node:timers/promises";
import { MINECRAFT_VERSION } from "../../src/config";
import { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import { ContainerSessionManager } from "../../src/runtime/ContainerSessionManager";
import { MineflayerWorldQueries } from "../../src/world/MineflayerWorldQueries";
import { createCapabilityRegistry } from "../../src/bootstrap/createCapabilities";
import { Executor } from "../../src/execution/Executor";
import { TaskFactory } from "../../src/execution/TaskFactory";
import { WorldControllerRuntime } from "../../src/devworld/controller/WorldControllerRuntime";
import { MineflayerCommandTransport } from "../../src/devworld/controller/MineflayerCommandTransport";
import { loadWorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { containsPosition } from "../../src/devworld/ArenaBounds";
import { BlockNbtReader, chestInventory } from "../../tests/e2e/BlockNbtReader";
import { bounded, until } from "../../tests/e2e/async";
import { cleanupSteps } from "../../src/runtime/cleanup";

/** Explicit live smoke: no LLM, no arena reset; refuses to overwrite occupied cells. */
async function main() {
  const config = loadWorldBuilderConfig({ ...process.env, WORLD_CONTROLLER_USERNAME: "test_controller", WORLD_AGENT_USERNAME: "audit_bot" });
  const chest = new Vec3(-39, -60, -40), log = new Vec3(-40, -60, -39);
  for (const p of [chest, log]) assert.ok(containsPosition(config.arena, p), "Fixture must be inside configured arena");
  const controller = new WorldControllerRuntime(config);
  const runtime = new MinecraftRuntime({ host: config.host, port: config.port, version: MINECRAFT_VERSION, username: "audit_bot", auth: "offline" });
  let transport: MineflayerCommandTransport | undefined;
  const created: Vec3[] = [];
  const command = async (text: string) => {
    await delay(1100);
    const result = await transport!.send(text);
    if (result.error) throw new Error(result.error);
  };
  try {
    await bounded(controller.connect(), 15_000, "Controller connection");
    assert.ok(!controller.bot.players.audit_bot, "audit_bot is already online");
    transport = new MineflayerCommandTransport(controller.bot, 300);
    await controller.initialize(transport);
    for (const p of [chest, log]) {
      assert.equal(controller.bot.blockAt(p)?.name, "air", `Refusing occupied/unloaded fixture ${p}`);
      assert.equal(controller.bot.blockAt(p.offset(0, -1, 0))?.name, "grass_block", "Expected superflat ground");
    }
    await bounded(runtime.connect(), 15_000, "Bot connection");
    await command("gamemode survival audit_bot");
    await command("tp audit_bot -39.5 -60 -40.5");
    for (const [p, block] of [[chest, "chest"], [log, "oak_log"]] as const) {
      created.push(p);
      await command(`setblock ${p.x} ${p.y} ${p.z} minecraft:${block}`);
      await until(() => runtime.bot.blockAt(p)?.name === block, 5_000, "Fixture propagation");
    }
    const reader = new BlockNbtReader(controller.bot._client);
    const raw = await reader.read(chest);
    console.info("Chest NBT (bounded)", JSON.stringify(raw).slice(0, 2000));
    const parsed = chestInventory(raw, controller.bot.blockAt(chest)?.name ?? null);
    console.info("Chest observation", parsed);
    assert.deepEqual(parsed, { ok: true, inventory: {} });
    await command('data merge block -39 -60 -40 {Items:[{Slot:0b,id:"minecraft:oak_log",count:2}]}');
    const filled = chestInventory(await reader.read(chest), controller.bot.blockAt(chest)?.name ?? null);
    console.info("Filled chest observation", filled);
    assert.deepEqual(filled, { ok: true, inventory: { oak_log: 2 } });
    const sessions = new ContainerSessionManager(runtime.bot);
    const world = new MineflayerWorldQueries(runtime);
    const executor = new Executor({ runtime, world, registry: createCapabilityRegistry(sessions), defaultTimeoutMs: 15_000 });
    const tasks = new TaskFactory();
    const found = await world.findNearestBlocks(["oak_log"], { maxDistance: 50, count: 1 });
    assert.ok(found.length > 0);
    const result = await executor.execute(tasks.create({ capability: "dig", input: { position: log } }));
    console.info("Server-confirmed dig", result);
    assert.equal(result.ok, true, JSON.stringify(result));
    const movement = await executor.execute(tasks.create({ capability: "goto", input: { position: log.offset(0.5, 0, 0.5), range: 0, canDig: false, canPlace: false } }));
    console.info("Navigation and pickup", movement);
    assert.equal(movement.ok, true, JSON.stringify(movement));
    await delay(1000);
    sessions.dispose();
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    console.info("Minecraft observation smoke passed (no LLM).");
  } finally {
    await cleanupSteps([
      ...created.map((p) => ({ name: `fixture ${p}`, run: async () => {
        const block = controller.bot.blockAt(p);
        if (block?.name === "chest") await command(`data merge block ${p.x} ${p.y} ${p.z} {Items:[]}`);
        if (block?.name === "chest" || block?.name === "oak_log") {
          await command(`setblock ${p.x} ${p.y} ${p.z} minecraft:air`);
          await until(() => controller.bot.blockAt(p)?.name === "air", 3000, "Fixture removal");
        }
      } })),
      { name: "bot", run: () => runtime.disconnect("Observation smoke completed") },
      { name: "transport", run: () => transport?.close() },
      { name: "controller", run: () => controller.disconnect() },
    ]);
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
