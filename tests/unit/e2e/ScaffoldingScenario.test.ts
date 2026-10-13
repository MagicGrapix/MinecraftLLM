import assert from "node:assert/strict";
import test from "node:test";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { scaffoldingScenario as scenario } from "../../e2e/ScaffoldingScenario";
import { observation } from "../../support/ScenarioObservations";

test("scaffolding scenario rejects leftover dirt, terrain damage, missing cells and unfinished pillar", () => {
  const config = loadWorldBuilderConfig({}), origin = scenario.fixedBuild!(config).origin;
  const initial = observation({ inventory: { ...scenario.initialInventory }, blocks: scenario.observeBlocks!(config).map(position => ({
    position, name: position.y < origin.y ? "grass_block" : "air",
  })) });
  const blocks = initial.blocks.map(b => ({ ...b, name: b.position.x === 5 && b.position.z === 5
    && b.position.y >= origin.y && b.position.y < origin.y + 5 ? "oak_planks" : b.name }));
  const current = observation({ inventory: { dirt: 20 }, blocks });
  assert.equal(scenario.verify(initial, current).passed, true);
  for (const [x, y, z, name] of [[4, origin.y, 5, "dirt"], [4, origin.y - 1, 5, "air"], [5, origin.y + 4, 5, "air"]] as const) {
    const changed = blocks.map(b => b.position.x === x && b.position.y === y && b.position.z === z ? { ...b, name } : b);
    assert.equal(scenario.verify(initial, { ...current, blocks: changed }).passed, false);
  }
  assert.equal(scenario.verify(initial, { ...current, blocks: blocks.slice(1) }).passed, false);
  assert.equal(scenario.verify(initial, { ...current, position: { x: 5.5, y: origin.y + 5, z: 5.5 } }).passed, false);
  assert.equal(scenario.verify(initial, { ...current, physicalIdle: false }).passed, false);
});
