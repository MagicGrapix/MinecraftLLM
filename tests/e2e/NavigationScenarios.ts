import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { blockAt, blockFixture, fixtureFields } from "./ScenarioFixtures";
import type { Observation, Scenario } from "./types";

function wall(config: WorldBuilderConfig) {
  const y = config.surfaceY + 1;
  return blockFixture(config, "Wall with open paths around both ends", [
    { min: { x: -2, y, z: 3 }, max: { x: 2, y: y + 2, z: 3 }, name: "stone" },
    { min: { x: 0, y: y - 1, z: 6 }, max: { x: 0, y: y - 1, z: 6 }, name: "cobblestone" },
  ]);
}
function pillar(config: WorldBuilderConfig) {
  const y = config.surfaceY + 1;
  return blockFixture(config, "Two-block pillar with a cobblestone top", [
    { min: { x: 6, y, z: 0 }, max: { x: 6, y, z: 0 }, name: "stone" },
    { min: { x: 6, y: y + 1, z: 0 }, max: { x: 6, y: y + 1, z: 0 }, name: "cobblestone" },
  ]);
}
function onMarker(initial: Observation, current: Observation): boolean {
  const marker = initial.blocks.find((b) => b.name === "cobblestone");
  return !!marker && current.onGround
    && Math.abs(current.position.y - marker.position.y - 1) < 0.1
    && Math.floor(current.position.x) === marker.position.x && Math.floor(current.position.z) === marker.position.z;
}
function fixtureIntact(initial: Observation, current: Observation): boolean {
  return initial.blocks.filter((b) => b.name === "stone" || b.name === "cobblestone")
    .every((b) => blockAt(current, b.position) === b.name);
}

export const navigationScenarios: readonly Scenario[] = [
  {
    id: "navigate_around_wall",
    prompt: "Go around the stone wall and stand on the cobblestone ground marker beyond it. Keep the wall intact.",
    initialInventory: {}, ...fixtureFields(wall),
    verify: (initial, current) => ({
      passed: onMarker(initial, current) && fixtureIntact(initial, current),
      expected: "Stand on the marker beyond the wall with every wall block intact",
      actual: `On marker ${onMarker(initial, current)}; wall intact ${fixtureIntact(initial, current)}`,
    }),
  },
  {
    id: "navigate_with_scaffolding",
    prompt: "Stand on the cobblestone top of the nearby stone pillar. Build access using your dirt, keep the pillar intact, and leave the access blocks in place.",
    initialInventory: { dirt: 12 }, ...fixtureFields(pillar),
    observeBlocks: (config) => {
      const positions = [];
      for (let x = 4; x <= 8; x++) for (let z = -2; z <= 2; z++) for (let y = config.surfaceY + 1; y <= config.surfaceY + 2; y++) positions.push({ x, y, z });
      return positions;
    },
    verify: (initial, current) => {
      const placed = initial.blocks.filter((b) => b.name === "air" && blockAt(current, b.position) === "dirt").length;
      const used = (initial.inventory.dirt ?? 0) - (current.inventory.dirt ?? 0);
      return { passed: onMarker(initial, current) && fixtureIntact(initial, current) && placed > 0 && used > 0,
        expected: "Stand atop the intact pillar with new dirt access blocks and dirt consumed from inventory",
        actual: `On marker ${onMarker(initial, current)}; pillar intact ${fixtureIntact(initial, current)}; placed dirt ${placed}; dirt used ${used}` };
    },
  },
];
