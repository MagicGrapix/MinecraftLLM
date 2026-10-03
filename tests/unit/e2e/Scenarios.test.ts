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
