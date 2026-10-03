import assert from "node:assert/strict";
import test from "node:test";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { TestWorld } from "../../e2e/TestWorld";
import { scenarios } from "../../e2e/scenarios";
import { observation } from "../../support/ScenarioObservations";
import type { WorldPlan } from "../../../src/devworld/WorldPlan";

/** Replace only I/O boundaries; exercise the real setup ordering and readiness checks. */
function setup() {
  const config = loadWorldBuilderConfig({});
  const world = new TestWorld(config, () => undefined);
  const internals = world as any;
  const bot = { game: { difficulty: "normal" }, players: { [config.agentUsername]: {} } };
  const commands: string[] = [];
  internals.runtime = { bot };
  internals.execute = async (plan: WorldPlan) => { commands.push(...plan.commands.map((c) => c.text)); };
  return { world, internals, bot, commands };
}

test("hungry setup adds a bounded hunger effect and does not clear it prematurely", async () => {
  const h = setup(), scenario = scenarios.find((s) => s.id === "eat_food")!;
  let polls = 0;
  const observed = await h.world.preparePlayer(scenario, async () => {
    polls++;
    return observation({ inventory: { cooked_beef: 1 }, food: polls === 1 ? 20 : 15, effects: polls === 1 ? 1 : 0 });
  });
  assert.equal(polls, 2);
  assert.equal(observed.food, 15);
  assert.match(h.commands.at(-1)!, /^effect give \w+ minecraft:hunger 4 255 true$/);
  assert.match(h.commands.at(-2)!, /^effect clear /);
  assert.equal(h.commands.some((c) => c.startsWith("difficulty ")), false);
});

test("peaceful hunger setup fails clearly without mutating the server", async () => {
  const h = setup(); h.bot.game.difficulty = "peaceful";
  await assert.rejects(h.world.preparePlayer(scenarios.find((s) => s.id === "eat_food")!, async () => observation()), /requires easy, normal or hard/);
  assert.equal(h.commands.length, 0);
});

test("loose-item fixture is spawned after strict empty-world verification", async () => {
  const h = setup(), scenario = scenarios.find((s) => s.id === "collect_dropped_logs")!;
  const phases: string[] = [];
  h.internals.execute = async (plan: WorldPlan) => phases.push(plan.commands.some((c) => c.text.startsWith("summon ")) ? "spawn" : "reset");
  h.internals.verifyTerrain = async () => phases.push("verify_empty");
  h.world.observeEnvironment = async () => { phases.push("observe_loot"); return { drops: scenario.drops!(h.world.config) }; };
  await h.world.prepareTerrain(scenario);
  assert.deepEqual(phases, ["reset", "verify_empty", "verify_empty", "spawn", "observe_loot"]);
});
