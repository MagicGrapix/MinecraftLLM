import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BlueprintSchema } from "../../src/building/Blueprint";
import { containsPosition } from "../../src/devworld/ArenaBounds";
import type { Position } from "../../src/shared/types";
import type { Observation, Scenario } from "./types";

const pillar = BlueprintSchema.parse(JSON.parse(readFileSync(join(__dirname, "../fixtures/blueprints/tall-oak-pillar.json"), "utf8")));
const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const originAt = (y: number): Position => ({ x: 5, y, z: 5 });
function positions(origin: Position): Position[] {
  const cells: Position[] = [];
  for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) {
    for (let y = origin.y - 4; y <= origin.y + 5; y++) cells.push({ x, y, z });
  }
  return cells;
}

/** Independent final oracle: the five permanent blocks and the entire temporary work margin. */
export function verifyScaffoldedPillar(initial: Observation, current: Observation) {
  const origin = originAt(Math.round(initial.position.y));
  const before = new Map(initial.blocks.map(b => [key(b.position), b]));
  const after = new Map(current.blocks.map(b => [key(b.position), b]));
  let mismatchCount = 0;
  const mismatches: unknown[] = [];
  const mismatch = (detail: unknown) => { mismatchCount++; if (mismatches.length < 20) mismatches.push(detail); };
  for (const p of positions(origin)) {
    const previous = before.get(key(p))?.name, actual = after.get(key(p))?.name;
    const permanent = p.x === origin.x && p.z === origin.z && p.y >= origin.y && p.y < origin.y + 5;
    if (!previous || !actual) { mismatch({ position: p, reason: "unavailable" }); continue; }
    if (permanent) {
      if (previous !== "air" || actual !== "oak_planks") mismatch({ position: p, expected: "oak_planks", actual });
    } else if (previous !== actual && !(p.y === origin.y - 1 && previous === "grass_block" && actual === "dirt")) {
      mismatch({ position: p, expected: previous, actual });
    }
  }
  const used = (initial.inventory.oak_planks ?? 0) - (current.inventory.oak_planks ?? 0);
  if (used !== 5) mismatch({ reason: "material_consumption", expected: 5, used });
  const dirt = current.inventory.dirt ?? 0;
  if (dirt < 0 || dirt > (initial.inventory.dirt ?? 0)) mismatch({ reason: "unexpected_dirt_gain", dirt });
  if (current.health <= 0 || !current.physicalIdle || !current.onGround || current.windowOpen ||
    Math.abs(current.position.y - origin.y) > 0.1 ||
    (Math.floor(current.position.x) === origin.x && Math.floor(current.position.z) === origin.z)) {
    mismatch({ reason: "bot_not_safely_on_ground" });
  }
  return { passed: mismatchCount === 0,
    expected: "Five-block oak pillar; temporary dirt removed, ground intact, idle bot on exterior ground",
    actual: `${positions(origin).length} observed cells; ${mismatchCount} mismatch(es); ${used} planks consumed`,
    details: { mismatchCount, mismatches, dirtRemainingInInventory: dirt } };
}

export const scaffoldingScenario: Scenario = {
  id: "build_with_scaffolding",
  prompt: "Build the fixed tall pillar, then remove your temporary dirt access.",
  initialInventory: { oak_planks: 5, dirt: 24 },
  fixedBuild: config => ({ blueprint: structuredClone(pillar), origin: originAt(config.surfaceY + 1) }),
  observeBlocks: config => {
    const cells = positions(originAt(config.surfaceY + 1));
    if (cells.some(p => !containsPosition(config.arena, p))) throw new Error("Scaffolding test must fit inside the arena.");
    return cells;
  },
  verify: verifyScaffoldedPillar,
};
