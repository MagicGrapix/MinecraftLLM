import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BlueprintSchema } from "../../src/building/Blueprint";
import { containsPosition } from "../../src/devworld/ArenaBounds";
import type { Position } from "../../src/shared/types";
import { MAX_OBSERVED_BLOCKS } from "./BlockObservations";
import type { BlockObservation, Observation, Scenario } from "./types";

// Independent fixed oracle: the test never trusts the builder's success/progress report.
const house = BlueprintSchema.parse(JSON.parse(readFileSync(join(__dirname, "../fixtures/blueprints/small-oak-house.json"), "utf8")));
const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const originAt = (feetY: number): Position => ({ x: 5, y: feetY, z: 5 });

/** Full drawing, two-block horizontal margin, protected foundation and air above roof. */
export function shelterObservationPositions(origin: Position): Position[] {
  const positions: Position[] = [];
  for (let y = origin.y - 4; y <= origin.y + house.layers.length; y++) {
    for (let z = origin.z - 2; z < origin.z + house.depth + 2; z++) {
      for (let x = origin.x - 2; x < origin.x + house.width + 2; x++) positions.push({ x, y, z });
    }
  }
  if (positions.length > MAX_OBSERVED_BLOCKS) throw new Error("Shelter observation exceeds the bounded cell budget.");
  return positions;
}

/** Expected states for this symmetric reference house, not the production build verifier. */
export function shelterExpectedBlocks(origin: Position): BlockObservation[] {
  const blocks: BlockObservation[] = [];
  house.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((symbol, x) => {
    if (symbol !== "_") blocks.push({ position: { x: origin.x + x, y: origin.y + y, z: origin.z + z },
      name: symbol === "." ? "air" : house.palette[symbol]!, properties: {} });
  })));
  for (const door of house.dependencies.doors) for (const half of ["lower", "upper"] as const) {
    blocks.push({ position: { x: origin.x + door.position.x, y: origin.y + door.position.y + (half === "upper" ? 1 : 0), z: origin.z + door.position.z },
      name: door.item, properties: { facing: door.facing, half, hinge: "left", open: false, powered: false } });
  }
  return blocks;
}

const materials = { oak_planks: 55, cobblestone: 25, oak_door: 1 };

export function verifyFixedShelter(initial: Observation, current: Observation) {
  const origin = originAt(Math.round(initial.position.y));
  const expected = new Map(shelterExpectedBlocks(origin).map(b => [key(b.position), b]));
  const before = new Map(initial.blocks.map(b => [key(b.position), b]));
  const after = new Map(current.blocks.map(b => [key(b.position), b]));
  let mismatchCount = 0, unknownCells = 0;
  const mismatches: unknown[] = [];
  const mismatch = (detail: unknown) => { mismatchCount++; if (mismatches.length < 20) mismatches.push(detail); };
  const positions = shelterObservationPositions(origin);
  for (const position of positions) {
    const id = key(position), previous = before.get(id), observed = after.get(id), target = expected.get(id);
    if (!previous?.name || !observed?.name) {
      unknownCells++; mismatch({ position, reason: "unavailable", before: previous ?? null, observed: observed ?? null }); continue;
    }
    if (target) {
      if (previous.name !== "air") mismatch({ position, reason: "fixture_not_empty", observed: previous.name });
      if (observed.name !== target.name || Object.entries(target.properties ?? {}).some(([k, v]) => observed.properties?.[k] !== v)) {
        mismatch({ position, reason: "blueprint_mismatch", expected: target, observed });
      }
    } else {
      // Grass beneath the new opaque floor naturally becomes dirt. No other excavation is allowed.
      const coveredGround = position.y === origin.y - 1 && position.x >= origin.x && position.x < origin.x + house.width
        && position.z >= origin.z && position.z < origin.z + house.depth;
      if (previous.name !== observed.name && !(coveredGround && previous.name === "grass_block" && observed.name === "dirt")) {
        mismatch({ position, reason: "protected_cell_changed", expected: previous.name, observed: observed.name });
      }
    }
  }
  const inventory = [...new Set([...Object.keys(initial.inventory), ...Object.keys(current.inventory), ...Object.keys(materials)])].map(item => ({
    item, used: (initial.inventory[item] ?? 0) - (current.inventory[item] ?? 0), expected: (materials as Record<string, number>)[item] ?? 0,
  }));
  for (const item of inventory) if (item.used !== item.expected) mismatch({ reason: "inventory_mismatch", ...item });
  const botState = { alive: current.health > 0, onGround: current.onGround, physicalIdle: current.physicalIdle, windowClosed: !current.windowOpen };
  if (Object.values(botState).some(ok => !ok)) mismatch({ reason: "bot_not_ready", ...botState });
  return {
    passed: mismatchCount === 0,
    expected: "Reference house, empty interior, closed north-facing two-half door; protected surroundings; exact materials consumed; healthy idle bot",
    actual: `${positions.length} observed cells, ${mismatchCount} mismatch(es), ${unknownCells} unavailable cell(s)`,
    details: { expectedCells: expected.size, observedCells: positions.length, unknownCells, mismatchCount, mismatches, inventory, botState },
  };
}

export const buildingScenarios: readonly Scenario[] = [{
  id: "build_small_shelter",
  prompt: "Build the fixed reference shelter at the prepared origin using the supplied materials.",
  initialInventory: materials,
  fixedBuild: config => ({ blueprint: structuredClone(house), origin: originAt(config.surfaceY + 1) }),
  observeBlocks: config => {
    const positions = shelterObservationPositions(originAt(config.surfaceY + 1));
    if (positions.some(p => !containsPosition(config.arena, p))) throw new Error("Shelter observation volume must fit inside the testing arena.");
    return positions;
  },
  verify: verifyFixedShelter,
}];
