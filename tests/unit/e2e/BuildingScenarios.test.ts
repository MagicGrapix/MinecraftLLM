import assert from "node:assert/strict";
import test from "node:test";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { buildingScenarios, shelterExpectedBlocks, verifyFixedShelter } from "../../e2e/BuildingScenarios";
import { observation } from "../../support/ScenarioObservations";
import type { BlockObservation } from "../../e2e/types";

const config = loadWorldBuilderConfig({});
const scenario = buildingScenarios[0]!;
const spec = scenario.fixedBuild!(config);
const key = (b: BlockObservation) => JSON.stringify(b.position);
function states() {
  const initial = observation({ inventory: { ...scenario.initialInventory },
    blocks: scenario.observeBlocks!(config).map(position => ({ position, properties: {},
      name: position.y === config.surfaceY ? "grass_block" : position.y === config.surfaceY - 3 ? "bedrock" : position.y < config.surfaceY ? "dirt" : "air" })),
  });
  const expected = new Map(shelterExpectedBlocks(spec.origin).map(b => [key(b), b]));
  const current = observation({ blocks: initial.blocks.map(b => expected.get(key(b)) ?? b) });
  return { initial, current };
}

test("fixed shelter covers 100 blueprint cells plus a protected margin; supplied stock, no LLM", () => {
  const { initial, current } = states();
  assert.equal(initial.blocks.length, 729);
  assert.equal(shelterExpectedBlocks(spec.origin).length, 100);
  assert.equal(verifyFixedShelter(initial, current).passed, true);
  assert.equal(verifyFixedShelter(initial, initial).passed, false);
  assert.equal(spec.blueprint.dependencies.doors.length, 1);
  assert.throws(() => scenario.observeBlocks!({ ...config, arena: { ...config.arena, max: { x: 8, y: -30, z: 8 } } }), /arena/);
});

test("house oracle rejects a mismatch beyond the former 64-cell limit, unknown and missing cells", () => {
  const { initial, current } = states();
  const blocks = [...current.blocks]; blocks[728] = { ...blocks[728]!, name: "stone" };
  assert.equal(verifyFixedShelter(initial, { ...current, blocks }).passed, false);
  assert.equal(verifyFixedShelter(initial, { ...current, blocks: current.blocks.slice(0, 64) }).passed, false);
  blocks[728] = { ...blocks[728]!, name: null };
  assert.equal(verifyFixedShelter(initial, { ...current, blocks }).details.unknownCells, 1);
});

test("door verification checks properties of both halves, not only oak_door names", () => {
  const { initial, current } = states();
  for (const [property, wrong] of Object.entries({ facing: "south", half: "lower", hinge: "right", open: true, powered: true })) {
    const blocks = current.blocks.map(b => b.name === "oak_door" && b.properties?.half === "upper"
      ? { ...b, properties: { ...b.properties, [property]: wrong } } : b);
    assert.equal(verifyFixedShelter(initial, { ...current, blocks }).passed, false, property);
  }
  assert.equal(verifyFixedShelter(initial, { ...current, blocks: current.blocks.map(b => b.name === "oak_door" ? { ...b, properties: undefined } : b) }).passed, false);
});

test("required air, protected ground, materials and final bot condition are independently checked", () => {
  const { initial, current } = states();
  const alter = (x: number, y: number, z: number, name: string) => current.blocks.map(b => b.position.x === x && b.position.y === y && b.position.z === z ? { ...b, name } : b);
  assert.equal(verifyFixedShelter(initial, { ...current, blocks: alter(6, -59, 6, "oak_planks") }).passed, false);
  assert.equal(verifyFixedShelter(initial, { ...current, blocks: alter(5, -61, 5, "dirt") }).passed, true); // Natural covered grass.
  assert.equal(verifyFixedShelter(initial, { ...current, blocks: alter(5, -61, 5, "air") }).passed, false);
  for (const change of [{ inventory: { oak_door: 1 } }, { health: 0 }, { physicalIdle: false }, { windowOpen: true }, { onGround: false }]) {
    assert.equal(verifyFixedShelter(initial, { ...current, ...change }).passed, false);
  }
});
