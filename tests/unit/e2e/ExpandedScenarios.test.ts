import assert from "node:assert/strict";
import test from "node:test";
import MinecraftData from "minecraft-data";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { scenarios } from "../../e2e/scenarios";
import { blockAt } from "../../e2e/ScenarioFixtures";
import { playerReady } from "../../e2e/TestWorld";
import type { Observation, Scenario } from "../../e2e/types";
import { observation } from "../../support/ScenarioObservations";
import { MAX_OBSERVED_BLOCKS } from "../../e2e/BlockObservations";

const config = loadWorldBuilderConfig({});
const get = (id: string) => scenarios.find((s) => s.id === id)!;
function initial(s: Scenario): Observation {
  const expected = s.expectedBlocks?.(config) ?? [];
  return observation({ inventory: { ...s.initialInventory }, food: s.hungry ? 15 : 20,
    blocks: (s.observeBlocks?.(config) ?? []).map((position) => ({ position,
      name: expected.find((b) => JSON.stringify(b.position) === JSON.stringify(position))?.name ?? "air" })),
    containers: s.containers?.(config).map((c) => ({ position: c.position, inventory: { ...c.items } })),
    drops: s.drops?.(config),
  });
}

test("craft 3x3 requires a new pickaxe and an intact supplied crafting table", () => {
  const s = get("craft_wooden_pickaxe"), before = initial(s);
  assert.deepEqual(before.inventory, { oak_planks: 3, stick: 2 });
  assert.equal(s.verify(before, before).passed, false);
  const after = { ...before, inventory: { wooden_pickaxe: 1 } };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, { ...after, blocks: [] }).passed, false);
  assert.equal(s.verify({ ...before, inventory: { wooden_pickaxe: 1 } }, after).passed, false);
});

test("two-tool crafting requires both new tools, not just one or existing stock", () => {
  const s = get("craft_two_wooden_tools"), before = initial(s);
  assert.deepEqual(before.inventory, { oak_planks: 6, stick: 4 });
  const after = { ...before, inventory: { wooden_axe: 1, wooden_pickaxe: 1 } };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, before).passed, false);
  const singleTools: Record<string, number>[] = [{ wooden_axe: 1 }, { wooden_pickaxe: 1 }];
  for (const inventory of singleTools) {
    assert.equal(s.verify(before, { ...after, inventory }).passed, false);
    assert.equal(s.verify({ ...before, inventory }, after).passed, false);
  }
  assert.equal(s.verify(before, { ...after, blocks: [] }).passed, false);
});

function removeStone(before: Observation, count: number) {
  let removed = 0;
  return before.blocks.map((block) => block.name === "stone" && removed++ < count ? { ...block, name: "air" } : block);
}

test("stone collection requires both mining the mound and collecting four new drops", () => {
  const s = get("collect_cobblestone_from_mound"), before = initial(s);
  assert.deepEqual(before.inventory, { wooden_pickaxe: 1 });
  const after = { ...before, inventory: { wooden_pickaxe: 1, cobblestone: 4 }, blocks: removeStone(before, 4) };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, { ...after, inventory: before.inventory }).passed, false);
  assert.equal(s.verify(before, { ...after, inventory: { cobblestone: 3 } }).passed, false);
  assert.equal(s.verify({ ...before, inventory: { cobblestone: 4 } }, after).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: removeStone(before, 3) }).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: [] }).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: after.blocks.map(b => ({ ...b, name: null })) }).passed, false);
});

test("stone pickaxe progression starts empty and requires mined stone plus the final tool", () => {
  const s = get("craft_stone_pickaxe_from_world"), before = initial(s);
  assert.deepEqual(before.inventory, {});
  assert.equal(before.blocks.filter(b => b.name === "oak_log").length, 8);
  assert.equal(before.blocks.some(b => b.name === "crafting_table"), false);
  const after = { ...before, inventory: { stone_pickaxe: 1 }, blocks: removeStone(before, 3) };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, { ...after, inventory: { wooden_pickaxe: 1, cobblestone: 3 } }).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: removeStone(before, 2) }).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: [] }).passed, false);
  assert.equal(s.verify({ ...before, inventory: { wooden_pickaxe: 1 } }, after).passed, false);
});

test("iron progression requires both pickaxes, mined resources and a successful furnace operation", () => {
  const s = get("craft_iron_pickaxe_from_world"), before = initial(s);
  assert.deepEqual(before.inventory, {});
  assert.equal(s.timeoutMs, 600_000);
  const required: Record<string, number> = { oak_log: 1, stone: 11, coal_ore: 1, iron_ore: 3 };
  function removeSources(counts = required, replacement: string | null = "air") {
    const remaining = { ...counts };
    return before.blocks.map(block => {
      const name = block.name ?? "";
      if ((remaining[name] ?? 0) <= 0) return block;
      remaining[name]!--;
      return { ...block, name: replacement };
    });
  }
  const after: Observation = { ...before, inventory: { stone_pickaxe: 1, iron_pickaxe: 1 },
    successfulTools: ["use_furnace"], blocks: removeSources() };
  assert.equal(s.verify(before, before).passed, false);
  assert.equal(s.verify(before, after).passed, true);
  // Replacing a removed block is allowed; unavailable observations are not removals.
  assert.equal(s.verify(before, { ...after, blocks: removeSources(required, "dirt") }).passed, true);
  const invalidStates: Observation[] = [
    { ...after, inventory: { stone_pickaxe: 1 } },
    { ...after, inventory: { iron_pickaxe: 1 } },
    { ...after, inventory: { stone_pickaxe: 1, iron_ingot: 3 } },
    { ...after, successfulTools: [] },
    { ...after, successfulTools: ["get_furnace_contents"] },
    { ...after, successfulTools: undefined },
    { ...after, windowOpen: true },
    { ...after, blocks: [] },
    { ...after, blocks: removeSources(required, null) },
    { ...after, blocks: before.blocks, completedSteps: 20 },
  ];
  for (const [name, count] of Object.entries(required)) {
    invalidStates.push({ ...after, blocks: removeSources({ ...required, [name]: count - 1 }) });
  }
  for (const invalid of invalidStates) assert.equal(s.verify(before, invalid).passed, false, s.verify(before, invalid).actual);
  assert.equal(s.verify({ ...before, inventory: { wooden_pickaxe: 1 } }, after).passed, false);
});

test("iron progression supplies a fixed accessible resource budget without tools or workstations", () => {
  const s = get("craft_iron_pickaxe_from_world"), blocks = s.expectedBlocks!(config);
  for (const [name, count] of Object.entries({ oak_log: 12, stone: 14, coal_ore: 4, iron_ore: 6 })) {
    const sources = blocks.filter(b => b.name === name);
    assert.equal(sources.length, count, name);
    assert.ok(sources.every(b => Math.hypot(b.position.x - 0.5, b.position.z - 0.5) < 16));
    if (name !== "oak_log") {
      for (const { position } of sources) {
        assert.equal(position.y, config.surfaceY + 2);
        assert.equal(blockAt({ blocks }, { ...position, y: position.y - 1 }), "dirt");
        assert.equal(blockAt({ blocks }, { ...position, y: position.y + 1 }), null);
      }
    }
  }
  assert.ok(blocks.every(b => !["crafting_table", "furnace"].includes(b.name)));
  for (const position of [{ x: 7, z: 5 }, { x: 14, z: 5 }, { x: 10, z: 4 }, { x: 10, z: 9 }]) {
    assert.equal(blockAt({ blocks }, { ...position, y: config.surfaceY + 1 }), "grass_block");
  }
  const written = new Map<string, string>();
  for (const command of s.fixture!(config).commands) {
    const [, x1, y1, z1, x2, y2, z2, block] = command.text.split(" ");
    for (let x = Number(x1); x <= Number(x2); x++) for (let y = Number(y1); y <= Number(y2); y++) {
      for (let z = Number(z1); z <= Number(z2); z++) written.set(`${x},${y},${z}`, block!.split("[")[0]!.replace("minecraft:", ""));
    }
  }
  assert.equal(new Set(blocks.map(b => JSON.stringify(b.position))).size, blocks.length);
  assert.deepEqual(written, new Map(blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b.name])));
  assert.deepEqual(s.observeBlocks!(config), blocks.map(b => b.position));
  assert.throws(() => s.fixture!({ ...config, arena: { min: { x: -1, y: -64, z: -1 }, max: { x: 1, y: -30, z: 1 } } }), /outside/);
  assert.deepEqual(s.expectedBlocks!({ ...config, surfaceY: -60 }).map(b => b.position.y), blocks.map(b => b.position.y + 1));
});

test("resource scenarios share a fixed walkable mound whose fill commands match every expected cell", () => {
  const mound = get("collect_cobblestone_from_mound");
  const blocks = mound.expectedBlocks!(config);
  const stone = blocks.filter(b => b.name === "stone");
  assert.equal(stone.length, 9);
  assert.ok(stone.every(b => b.position.y === config.surfaceY + 2));
  assert.ok(blocks.every(b => Math.hypot(b.position.x, b.position.z) > 6));
  for (const block of blocks.filter(b => b.position.y > config.surfaceY)) {
    assert.notEqual(blockAt({ blocks }, { ...block.position, y: block.position.y - 1 }), null);
    if (block.name === "grass_block") {
      assert.equal(blockAt({ blocks }, { ...block.position, y: block.position.y + 1 }), null);
    }
  }
  for (const id of [mound.id, "craft_stone_pickaxe_from_world"]) {
    const s = get(id), expected = s.expectedBlocks!(config);
    assert.deepEqual(expected.filter(b => b.name === "stone"), stone);
    assert.equal(new Set(expected.map(b => JSON.stringify(b.position))).size, expected.length);
    const written = new Map<string, string>();
    for (const command of s.fixture!(config).commands) {
      const [, x1, y1, z1, x2, y2, z2, block] = command.text.split(" ");
      for (let x = Number(x1); x <= Number(x2); x++) for (let y = Number(y1); y <= Number(y2); y++) {
        for (let z = Number(z1); z <= Number(z2); z++) written.set(`${x},${y},${z}`, block!.split("[")[0]!.replace("minecraft:", ""));
      }
    }
    assert.deepEqual(written, new Map(expected.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b.name])));
    assert.throws(() => s.fixture!({ ...config, arena: { min: { x: -1, y: -64, z: -1 }, max: { x: 1, y: -30, z: 1 } } }), /outside/);
    assert.deepEqual(s.expectedBlocks!({ ...config, surfaceY: -60 }).map(b => b.position.y), expected.map(b => b.position.y + 1));
  }
});

test("loose-item collection requires inventory gain, not disappearance alone", () => {
  const s = get("collect_dropped_logs"), before = initial(s);
  const after = { ...before, inventory: { oak_log: 4 }, drops: [] };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, { ...after, inventory: {} }).passed, false);
  assert.equal(s.verify(before, { ...after, inventory: { oak_log: 3 } }).passed, false);
  assert.equal(s.verify(before, { ...after, drops: undefined }).passed, false);
  assert.equal(s.verify(before, { ...after, drops: [{ position: before.drops![0]!.position, item: null, count: null }] }).passed, false);
  assert.equal(s.verify(before, { ...after, drops: before.drops }).passed, false);
});

for (const direction of ["withdraw", "deposit"]) test(`chest ${direction} checks both inventories, exact count, chest and closed window`, () => {
  const s = get(`chest_${direction}`), before = initial(s);
  const after = { ...before, inventory: { oak_log: 2 }, containers: [{ position: before.containers![0]!.position, inventory: { oak_log: 2 } }],
    successfulTools: ["get_chest_contents"] };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, { ...after, containers: before.containers }).passed, false);
  assert.equal(s.verify(before, { ...after, inventory: { oak_log: 3 } }).passed, false);
  assert.equal(s.verify(before, { ...after, containers: [{ ...after.containers[0]!, inventory: null }] }).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: [] }).passed, false);
  assert.equal(s.verify(before, { ...after, windowOpen: true }).passed, false);
  assert.equal(s.verify(before, { ...after, successfulTools: [] }).passed, false);
  assert.equal(s.verify(before, { ...after, containers: [{ ...after.containers[0]!, position: { x: 8, y: -60, z: 0 } }] }).passed, false);
});

test("smelting requires inspection, three new ingots, consumed input, empty furnace output and closed window", () => {
  const s = get("smelt_iron"), before = initial(s);
  assert.deepEqual(before.inventory, { raw_iron: 3, coal: 1 });
  const after = { ...before, inventory: { iron_ingot: 3 }, successfulTools: ["get_furnace_contents"] };
  assert.equal(s.verify(before, after).passed, true);
  const invalidStates: Observation[] = [
    { ...after, inventory: { iron_ingot: 2 } },
    { ...after, inventory: { iron_ingot: 3, raw_iron: 1 } },
    { ...after, windowOpen: true }, { ...after, blocks: [] }, { ...after, successfulTools: [] },
    { ...after, containers: [{ ...after.containers![0]!, inventory: null }] },
    { ...after, containers: [{ ...after.containers![0]!, inventory: { iron_ingot: 1 } }] },
    { ...after, containers: [{ ...after.containers![0]!, inventory: { raw_iron: 1 } }] },
  ];
  for (const invalid of invalidStates) assert.equal(s.verify(before, invalid).passed, false);
  assert.equal(s.verify({ ...before, inventory: { iron_ingot: 3 } }, after).passed, false);
});

test("food setup requires hunger with the effect expired; success requires real consumption and food gain", () => {
  const s = get("eat_food"), before = initial(s);
  assert.equal(playerReady(before, s, -60), true);
  for (const food of [0, 5, 17, 20]) assert.equal(playerReady({ ...before, food }, s, -60), false);
  assert.equal(playerReady({ ...before, effects: 1 }, s, -60), false);
  assert.equal(s.verify(before, { ...before, inventory: {}, food: 20 }).passed, true);
  assert.equal(s.verify(before, { ...before, inventory: {} }).passed, false);
  assert.equal(s.verify(before, { ...before, food: 20 }).passed, false);
  assert.equal(s.verify(before, { ...before, inventory: {}, food: 20, effects: 1 }).passed, false);
});

test("wall navigation needs the correct standing position and the intact wall", () => {
  const s = get("navigate_around_wall"), before = initial(s);
  const after = { ...before, position: { x: 0.5, y: -60, z: 6.5 } };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, before).passed, false);
  assert.equal(s.verify(before, { ...after, position: { ...after.position, y: -59 } }).passed, false);
  assert.equal(s.verify(before, { ...after, onGround: false }).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: after.blocks.map((b) => b.name === "stone" ? { ...b, name: "air" } : b) }).passed, false);
});

test("scaffolding needs a placed access block, consumed dirt and an intact pillar", () => {
  const s = get("navigate_with_scaffolding"), before = initial(s);
  const target = { x: 5, y: -60, z: 0 };
  assert.equal(blockAt(before, target), "air");
  const blocks = before.blocks.map((b) => JSON.stringify(b.position) === JSON.stringify(target) ? { ...b, name: "dirt" } : b);
  const after = { ...before, blocks, inventory: { dirt: 11 }, position: { x: 6.5, y: -58, z: 0.5 } };
  assert.equal(s.verify(before, after).passed, true);
  assert.equal(s.verify(before, { ...after, blocks: before.blocks }).passed, false); // Dropping dirt is not building.
  assert.equal(s.verify(before, { ...after, inventory: before.inventory }).passed, false);
  assert.equal(s.verify(before, { ...after, position: before.position }).passed, false);
  assert.equal(s.verify(before, { ...after, blocks: blocks.filter((b) => b.name !== "stone") }).passed, false);
});

test("all fixed fixtures and item names are valid for the configured Minecraft version", () => {
  const registry = MinecraftData(config.version);
  for (const s of scenarios) {
    assert.ok((s.observeBlocks?.(config).length ?? 0) <= MAX_OBSERVED_BLOCKS, s.id);
    assert.deepEqual(s.fixture?.(config).commands, s.fixture?.(config).commands, s.id);
    for (const b of s.expectedBlocks?.(config) ?? []) assert.ok(registry.blocksByName[b.name], `${s.id}: ${b.name}`);
    for (const name of Object.keys(s.initialInventory)) assert.ok(registry.itemsByName[name], `${s.id}: ${name}`);
    for (const c of s.containers?.(config) ?? []) for (const name of Object.keys(c.items)) assert.ok(registry.itemsByName[name]);
    for (const d of s.drops?.(config) ?? []) assert.ok(registry.itemsByName[d.item]);
  }
  assert.equal(scenarios.some((s) => /impossible|missing/i.test(s.id)), false);
});
