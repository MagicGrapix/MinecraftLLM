import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Vec3 } from "vec3";
import { MINECRAFT_VERSION } from "../../src/config";
import { subscribeTrace } from "../../src/TraceLog";
import { BlueprintStore } from "../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../src/building/BlueprintValidator";
import { MaterialCatalog } from "../../src/world/MaterialCatalog";
import { BuildCapability } from "../../src/capabilities/Build";
import { GotoCapability } from "../../src/capabilities/Goto";
import { UseBlockCapability } from "../../src/capabilities/UseBlock";
import { CapabilityRegistry } from "../../src/capabilities/CapabilityRegistry";
import { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import { MineflayerWorldQueries } from "../../src/world/MineflayerWorldQueries";
import { Executor } from "../../src/execution/Executor";
import { TaskFactory } from "../../src/execution/TaskFactory";
import { WorldControllerRuntime } from "../../src/devworld/controller/WorldControllerRuntime";
import { MineflayerCommandTransport } from "../../src/devworld/controller/MineflayerCommandTransport";
import { loadWorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { containsPosition } from "../../src/devworld/ArenaBounds";
import { cleanupSteps } from "../../src/runtime/cleanup";
import { blueprintFixture } from "../../tests/support/blueprints";
import { bounded, until } from "../../tests/e2e/async";
import { runBuildingWorkflowSmoke } from "./build-workflow";

/** Explicit live test. No LLM, no whole-arena reset, no changes to player inventories. */
async function main() {
  const withDoors = process.argv.includes("--doors");
  const username = "build_test_bot";
  const config = loadWorldBuilderConfig({ ...process.env, WORLD_CONTROLLER_USERNAME: "test_controller", WORLD_AGENT_USERNAME: username });
  const origin = new Vec3(-24, -60, -24);
  assert.ok(containsPosition(config.arena, origin.offset(-2, -1, -2)) && containsPosition(config.arena, origin.offset(6, 5, 6)), "Smoke outside arena");
  const controller = new WorldControllerRuntime(config);
  const runtime = new MinecraftRuntime({ host: config.host, port: config.port, version: MINECRAFT_VERSION, username, auth: "offline" });
  const directory = await mkdtemp(join(tmpdir(), "minecraft-build-smoke-"));
  let transport: MineflayerCommandTransport | undefined;
  let executor: Executor | undefined;
  let ownsSite = false;
  let unsubscribe = () => {};
  const command = async (text: string) => {
    await delay(1100);
    const result = await transport!.send(text);
    if (result.error) throw new Error(result.error);
  };
  const clearFixture = async () => {
    for (const block of ["oak_door", "oak_planks", "cobblestone"]) {
      await command(`fill ${origin.x} ${origin.y} ${origin.z} ${origin.x + 4} ${origin.y + 3} ${origin.z + 4} air replace ${block}`);
    }
    // Covered grass can naturally turn to dirt while building; restore the test lawn.
    await command(`fill ${origin.x} ${origin.y - 1} ${origin.z} ${origin.x + 4} ${origin.y - 1} ${origin.z + 4} grass_block replace dirt`);
    await until(() => {
      for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
        if (controller.bot.blockAt(origin.offset(x, -1, z))?.name !== "grass_block") return false;
        for (let y = 0; y < 4; y++) if (controller.bot.blockAt(origin.offset(x, y, z))?.name !== "air") return false;
      }
      return true;
    }, 3000, "Test structure removed and grass restored");
  };
  try {
    await bounded(controller.connect(), 15_000, "Controller connection");
    assert.ok(!controller.bot.players[username], "Build test bot already online");
    transport = new MineflayerCommandTransport(controller.bot, 300);
    await controller.initialize(transport);
    for (let x = -2; x <= 6; x++) for (let z = -2; z <= 6; z++) {
      assert.ok(["grass_block", "dirt"].includes(controller.bot.blockAt(origin.offset(x, -1, z))?.name ?? ""), "Expected flat grass/dirt support");
      for (let y = 0; y <= 5; y++) assert.equal(controller.bot.blockAt(origin.offset(x, y, z))?.name, "air", "Refusing occupied/unloaded smoke area");
    }
    ownsSite = true;
    await bounded(runtime.connect(), 15_000, "Builder connection");
    await command(`gamemode survival ${username}`);
    await command(`tp ${username} ${origin.x - 1.5} ${origin.y} ${origin.z - 1.5}`);
    await until(() => runtime.bot.entity.onGround && runtime.bot.entity.position.distanceTo(origin) < 4, 5000, "Builder arrival");
    if (process.argv.includes("--workflow")) {
      await command(`clear ${username}`);
      await command(`give ${username} oak_planks 55`);
      await command(`give ${username} cobblestone 25`);
      await command(`give ${username} oak_door 1`);
      await until(() => runtime.bot.inventory.items().some(i => i.name === "oak_door" && i.count === 1), 3000, "Workflow stock");
      await runBuildingWorkflowSmoke(runtime, controller.bot, origin, directory);
      return;
    }
    const validator = new BlueprintValidator(new MaterialCatalog(runtime.bot.registry));
    const store = new BlueprintStore(validator, { directory });
    const registry = new CapabilityRegistry(); registry.register(new BuildCapability(directory));
    registry.register(new GotoCapability()); registry.register(new UseBlockCapability()); registry.freeze();
    executor = new Executor({ registry, runtime, world: new MineflayerWorldQueries(runtime) });
    const tasks = new TaskFactory();
    let confirmed = 0;
    let interruptAt = Infinity;
    unsubscribe = subscribeTrace((event, raw) => {
      if (event !== "build.event") return;
      const data = raw as { event: string; position?: unknown };
      if (data.event === "place_confirmed") {
        confirmed++;
        if (confirmed % 10 === 0) console.info("Confirmed blocks:", confirmed);
        if (confirmed === interruptAt) executor!.abortCurrent("Smoke interruption after two placements");
      }
    });
    const build = async (blueprintId: string) => {
      const result = await executor!.execute(tasks.create({ capability: "build", input: { blueprintId, origin: { x: origin.x, y: origin.y, z: origin.z } } }));
      console.info("Build result:", JSON.stringify(result)); return result;
    };
    await command(`clear ${username}`); await command(`give ${username} oak_planks 2`);
    await until(() => runtime.bot.inventory.items().some((i) => i.name === "oak_planks" && i.count === 2), 3000, "First stock");
    const small = await store.save({ name: "smoke_two", description: "Two blocks", width: 3, depth: 1, palette: { A: "oak_planks" }, layers: [["AA."]], dependencies: { doors: [] } });
    assert.ok(small.ok);
    assert.ok((await build(small.value.id)).ok, "Two-block build failed");
    await until(() => controller.bot.blockAt(origin)?.name === "oak_planks" && controller.bot.blockAt(origin.offset(1, 0, 0))?.name === "oak_planks", 3000, "Independent observer");
    await clearFixture();
    await until(() => runtime.bot.blockAt(origin)?.name === "air", 3000, "Fixture cleared");

    if (withDoors) {
      for (const facing of ["north", "south", "east", "west"] as const) {
        await command(`clear ${username}`); await command(`give ${username} oak_door 1`);
        await until(() => runtime.bot.inventory.items().some(i => i.name === "oak_door" && i.count === 1), 3000, "Door stock");
        const drawing = { name: `door_${facing}`, description: "Isolated oriented door", width: 1, depth: 1,
          palette: { A: "stone" }, layers: [["_"], ["_"]],
          dependencies: { doors: [{ item: "oak_door", position: { x: 0, y: 0, z: 0 }, facing }] } };
        const savedDoor = await store.save(drawing); assert.ok(savedDoor.ok);
        const result = await build(savedDoor.value.id); assert.ok(result.ok, JSON.stringify(result));
        await until(() => [0, 1].every(y => {
          const block = controller.bot.blockAt(origin.offset(0, y, 0)), p = block?.getProperties();
          return block?.name === "oak_door" && p?.facing === facing && p.hinge === "left" && p.open === false && p.powered === false && p.half === (y ? "upper" : "lower");
        }), 3000, `Independent ${facing} door verification`);
        await until(() => !runtime.bot.inventory.items().some(i => i.name === "oak_door"), 3000, "Exactly one door consumed");
        console.info(`Door ${facing}: both halves confirmed.`);
        await clearFixture();
        await until(() => runtime.bot.blockAt(origin)?.name === "air" && runtime.bot.blockAt(origin.offset(0, 1, 0))?.name === "air", 3000, "Door cleared");
      }
    }

    await command(`clear ${username}`); await command(`give ${username} oak_planks 55`); await command(`give ${username} cobblestone 25`);
    if (withDoors) await command(`give ${username} oak_door 1`);
    await until(() => runtime.bot.inventory.items().some((i) => i.name === "cobblestone" && i.count === 25), 3000, "House stock");
    const drawing = await blueprintFixture(withDoors); const saved = await store.save(drawing); assert.ok(saved.ok);
    interruptAt = confirmed + 2;
    const interrupted = await build(saved.value.id);
    assert.ok(!interrupted.ok && interrupted.error.code === "INTERRUPTED");
    await executor.waitForIdle(10_000); interruptAt = Infinity;
    const resumed = await build(saved.value.id); assert.ok(resumed.ok, JSON.stringify(resumed));
    const compiled = validator.validate(drawing); assert.ok(compiled.ok);
    const structureMatches = () => compiled.value.cells.every(cell => {
      if (cell.kind === "ignore") return true;
      const actual = controller.bot.blockAt(origin.offset(cell.position.x, cell.position.y, cell.position.z));
      if (cell.kind === "door") return actual?.name === cell.block && Object.entries(cell.properties).every(([key, value]) => actual.getProperties()[key] === value);
      return actual?.name === (cell.kind === "block" ? cell.block : "air");
    });
    await until(structureMatches, 5000, "Independent full structure verification");
    const idempotent = await build(saved.value.id); assert.ok(idempotent.ok);
    assert.equal((idempotent.value as { placedThisCall: number }).placedThisCall, 0);
    assert.equal(runtime.bot.inventory.items().filter(i => ["oak_planks", "cobblestone", "oak_door"].includes(i.name)).length, 0);
    if (withDoors) {
      const go = async (p: Vec3) => {
        const result = await executor!.execute(tasks.create({ capability: "goto", input: { position: { x: p.x, y: p.y, z: p.z }, range: 0, canDig: false, canPlace: false } }));
        assert.ok(result.ok, JSON.stringify(result));
        assert.ok(runtime.bot.entity.position.floored().equals(p), "Bot did not reach the requested cell");
      };
      const doorPosition = origin.offset(2, 1, 0);
      const toggleDoor = async () => {
        const shape = runtime.bot.blockAt(doorPosition)?.shapes[0]; assert.ok(shape);
        const cursor = { x: (shape[0] + shape[3]) / 2, y: (shape[1] + shape[4]) / 2, z: (shape[2] + shape[5]) / 2 };
        const result = await executor!.execute(tasks.create({ capability: "use_block", input: { position: { x: doorPosition.x, y: doorPosition.y, z: doorPosition.z }, expectedBlock: "oak_door", hand: "hand", cursor } }));
        assert.ok(result.ok, JSON.stringify(result));
      };
      await go(origin.offset(2, 0, -1)); await toggleDoor();
      await until(() => runtime.bot.blockAt(doorPosition)?.getProperties().open === true && runtime.bot.blockAt(doorPosition.offset(0, 1, 0))?.getProperties().open === true, 3000, "Door opened");
      await go(origin.offset(2, 1, 2)); await go(origin.offset(2, 0, -1)); await toggleDoor();
      await until(structureMatches, 5000, "House remains intact after entering and exiting");
      console.info("Door smoke passed: four facings, interrupted/resumed 81-placement house, idempotency, opening/entering/exiting/closing. No LLM.");
    } else console.info("Build smoke passed: two cubes, interrupted/resumed 80-block shelter, required air and idempotency. No LLM.");
  } finally {
    executor?.abortCurrent("Smoke cleanup");
    await cleanupSteps([
      { name: "physical settlement", run: () => executor?.waitForIdle(10_000) },
      { name: "bot", run: () => runtime.disconnect("Build smoke finished") },
      { name: "fixture", run: async () => { if (ownsSite) await clearFixture(); } },
      { name: "trace observer", run: () => unsubscribe() },
      { name: "transport", run: () => transport?.close() },
      { name: "controller", run: () => controller.disconnect() },
      { name: "temporary blueprints", run: () => rm(directory, { recursive: true, force: true }) },
    ]);
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
