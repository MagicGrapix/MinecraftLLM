import assert from "node:assert/strict";
import test from "node:test";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { WorldBuilder } from "../../../src/devworld/WorldBuilder";
import { scenarios, oakFixture } from "../../e2e/scenarios";
import { playerReady } from "../../e2e/TestWorld";
import { parseOptions } from "../../e2e/options";
import { observation } from "../../support/ScenarioObservations";

test("terrain reset needs no online player and restores layers including debris cleanup", () => {
  const plan = new WorldBuilder({ config: loadWorldBuilderConfig({}) }).resetTerrain();
  assert.equal(plan.commands.some((c) => /^(clear|effect|tp|gamemode) /.test(c.text)), false);
  assert.match(plan.commands[0]!.text, /^kill @e/);
  assert.match(plan.commands.at(-1)!.text, /^kill @e/);
  assert.ok(plan.commands.some((c) => c.text.includes("minecraft:bedrock")));
  assert.ok(plan.commands.some((c) => c.text.includes("minecraft:grass_block")));
});

test("fixed tree is reproducible, bounded and uses only two fill commands", () => {
  const config = loadWorldBuilderConfig({});
  const wood = scenarios[1]!;
  assert.deepEqual(wood.fixture!(config).commands, wood.fixture!(config).commands);
  assert.equal(wood.fixture!(config).commands.length, 2);
  assert.equal(oakFixture(config).filter((b) => b.name === "oak_log").length, 4);
  assert.ok(wood.fixture!(config).commands[0]!.text.includes("persistent=true"));
  assert.throws(() => wood.fixture!({ ...config, arena: { min: { x: -1, y: -64, z: -1 }, max: { x: 1, y: -30, z: 1 } } }), /outside/);
});

test("verification measures gains and initial state requires a settled empty baseline", () => {
  const wood = scenarios[1]!;
  assert.equal(wood.verify(observation({ inventory: { oak_log: 2 } }), observation({ inventory: { oak_log: 2 } })).passed, false);
  assert.equal(playerReady(observation(), wood, -60), true);
  assert.equal(playerReady(observation({ inventory: { dirt: 1 } }), wood, -60), false);
  assert.equal(playerReady(observation({ physicalIdle: false }), wood, -60), false);
  assert.equal(playerReady(observation({ food: 10 }), wood, -60), false);
  assert.equal(playerReady(observation({ effects: 1 }), wood, -60), false);
  assert.equal(playerReady(observation({ yaw: 0 }), wood, -60), false);
});

test("CLI rejects ambiguous options and allows per-run deadline/repetition overrides", () => {
  assert.deepEqual(parseOptions(["--scenario", "craft_table", "--timeout", "90", "--repeat", "3", "--campaigns", "2", "--interval", "60"]), {
    scenario: "craft_table", timeoutMs: 90_000, repetitions: 3, campaigns: 2, intervalMs: 60_000, list: false, help: false,
  });
  for (const args of [["--timeout", "0"], ["--repeat"], ["--wat", "5"], ["--timeout", "NaN"]]) assert.throws(() => parseOptions(args));
});

test("four-log scenario uses three reproducible trees with non-overlapping geometry", () => {
  const scenario = scenarios.find((s) => s.id === "collect_four_logs")!;
  const config = loadWorldBuilderConfig({});
  const plan = scenario.fixture!(config);
  const blocks = scenario.expectedBlocks!(config);
  assert.deepEqual(plan.commands, scenario.fixture!(config).commands);
  assert.deepEqual(blocks, scenario.expectedBlocks!(config));
  assert.equal(plan.commands.length, 6);
  assert.equal(plan.commands.filter((c) => c.text.includes("persistent=true")).length, 3);
  assert.equal(blocks.filter((b) => b.name === "oak_log").length, 12);
  assert.equal(blocks.length, 3 * (27 + 4 - 2)); // Two trunk cells replace leaves in each crown.
  assert.equal(new Set(blocks.map((b) => `${b.position.x},${b.position.y},${b.position.z}`)).size, blocks.length);
  assert.deepEqual(blocks.filter((b) => b.name === "oak_log" && b.position.y === config.surfaceY + 1).map((b) => b.position), [
    { x: 5, y: -60, z: 0 }, { x: -5, y: -60, z: 4 }, { x: 3, y: -60, z: 9 },
  ]);
  // The expected geometry must match what the actual commands will write, in order.
  const written = new Map<string, string>();
  for (const command of plan.commands) {
    const [, x1, y1, z1, x2, y2, z2, block] = command.text.split(" ");
    for (let x = Number(x1); x <= Number(x2); x++) for (let y = Number(y1); y <= Number(y2); y++) {
      for (let z = Number(z1); z <= Number(z2); z++) written.set(`${x},${y},${z}`, block!.split("[")[0]!.replace("minecraft:", ""));
    }
  }
  assert.deepEqual(written, new Map(blocks.map((b) => [`${b.position.x},${b.position.y},${b.position.z}`, b.name])));
  assert.throws(() => scenario.fixture!({ ...config, arena: { min: { x: -2, y: -64, z: -2 }, max: { x: 6, y: -30, z: 2 } } }), /outside/);
  assert.deepEqual(scenario.expectedBlocks!({ ...config, surfaceY: 0 }).map((b) => b.position.y), blocks.map((b) => b.position.y + 61));
});

test("four logs means four new inventory blocks, not broken trunks or existing stock", () => {
  const scenario = scenarios.find((s) => s.id === "collect_four_logs")!;
  const initial = observation({ inventory: { oak_log: 2 } });
  assert.equal(scenario.verify(initial, observation({ inventory: { oak_log: 2 } })).passed, false);
  assert.equal(scenario.verify(initial, observation({ inventory: { oak_log: 5 } })).passed, false);
  assert.equal(scenario.verify(initial, observation({ inventory: { oak_log: 6 } })).passed, true);
  assert.deepEqual(scenario.initialInventory, {});
});

test("placement requires an initially empty front cell, an actual placed block and inventory consumption", () => {
  const scenario = scenarios.find((s) => s.id === "place_block_in_front")!;
  const config = loadWorldBuilderConfig({});
  const position = scenario.observeBlocks!(config)[0]!;
  assert.deepEqual(position, { x: 0, y: -60, z: 1 });
  assert.deepEqual(scenario.observeBlocks!({ ...config, surfaceY: 10 }), [{ x: 0, y: 11, z: 1 }]);
  const initial = observation({ inventory: { oak_planks: 1 }, blocks: [{ position, name: "air" }] });
  const placed = observation({ blocks: [{ position, name: "oak_planks" }] });
  assert.equal(playerReady(initial, scenario, -60), true);
  assert.equal(scenario.verify(initial, placed).passed, true);
  const roundedFeet = { ...initial, position: { ...initial.position, y: -60.000001 } };
  assert.equal(playerReady(roundedFeet, scenario, -60), true);
  assert.equal(scenario.verify(roundedFeet, placed).passed, true);
  assert.equal(scenario.verify(initial, observation({ blocks: [{ position, name: "air" }] })).passed, false); // Dropped.
  assert.equal(scenario.verify(initial, observation({ blocks: [{ position: { ...position, z: -1 }, name: "oak_planks" }] })).passed, false);
  assert.equal(scenario.verify(initial, observation({ blocks: [{ position, name: "dirt" }] })).passed, false);
  assert.equal(scenario.verify(initial, { ...placed, inventory: { oak_planks: 1 } }).passed, false);
  assert.equal(scenario.verify(initial, observation()).passed, false); // Missing observation.
  const unknown = { ...initial, blocks: [{ position, name: null }] };
  assert.equal(playerReady(unknown, scenario, -60), false);
  assert.equal(scenario.verify(unknown, placed).passed, false);
  assert.equal(scenario.verify(initial, { ...placed, blocks: unknown.blocks }).passed, false);
  assert.equal(scenario.verify({ ...initial, blocks: placed.blocks }, placed).passed, false); // Already present.
  // Looking or moving elsewhere does not redefine "in front of where you are standing now".
  assert.equal(scenario.verify(initial, { ...placed, yaw: 0, position: { x: 10.5, y: -60, z: 10.5 } }).passed, true);
});

test("all scenarios have unique ids and one bounded plain chat request", () => {
  assert.equal(scenarios.length, 11);
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
  for (const scenario of scenarios) {
    assert.ok(scenario.prompt.trim().length > 0 && scenario.prompt.length <= 220);
    assert.doesNotMatch(scenario.prompt, /^[\/]|[\r\n\u0000]/);
  }
});
