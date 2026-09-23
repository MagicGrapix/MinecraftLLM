import assert from "node:assert/strict";
import test from "node:test";
import {
  containsBounds,
  createArenaBounds,
} from "../../../src/devworld/ArenaBounds";
import type { RandomSource } from "../../../src/devworld/RandomSource";
import { FillCommandGenerator } from "../../../src/devworld/generators/FillCommandGenerator";
import { ForestGenerator } from "../../../src/devworld/generators/ForestGenerator";
import { OreVeinGenerator } from "../../../src/devworld/generators/OreVeinGenerator";
import { TreeGenerator } from "../../../src/devworld/generators/TreeGenerator";

const arena = createArenaBounds(
  { x: -48, y: -96, z: -48 },
  { x: 48, y: -30, z: 48 },
);

test("tree and forest positions are bounded, unique, and spaced", () => {
  const tree = new TreeGenerator({
    arena,
    surfaceY: -61,
    feature: "minecraft:oak",
    exclusionRadius: 4,
    footprintRadius: 4,
    maxHeight: 12,
    random: new LcgRandom(123),
  });
  const single = tree.generateNear({ x: 0, y: -60, z: 0 }, 10);
  assert.equal(single.position.y, -60);
  assert.match(
    single.command.text,
    /^place feature minecraft:oak -?\d+ -60 -?\d+$/,
  );
  assert.equal(
    containsBounds(arena, single.command.affectedBounds!),
    true,
  );

  const forest = new ForestGenerator({
    treeGenerator: tree,
    maxTrees: 32,
    maxRadius: 40,
    spacing: 5,
  }).generate({ x: 0, y: -60, z: 0 }, 10, 25);
  const keys = new Set(
    forest.trees.map(
      ({ position }) => `${position.x},${position.z}`,
    ),
  );
  assert.equal(keys.size, 10);
  for (let left = 0; left < forest.trees.length; left += 1) {
    for (
      let right = left + 1;
      right < forest.trees.length;
      right += 1
    ) {
      const a = forest.trees[left]!.position;
      const b = forest.trees[right]!.position;
      assert.equal(Math.hypot(a.x - b.x, a.z - b.z) >= 5, true);
    }
  }
});

test("ore generation creates a protected connected vein through old bedrock", () => {
  const generator = new OreVeinGenerator({
    arena,
    surfaceY: -61,
    maxVeinSize: 64,
    fill: new FillCommandGenerator(32_768),
    random: new LcgRandom(999),
  });
  const vein = generator.generate(
    { x: 0, y: -60, z: 0 },
    "iron",
    32,
  );

  assert.equal(vein.positions.length, 32);
  assert.equal(
    new Set(
      vein.positions.map(({ x, y, z }) => `${x},${y},${z}`),
    ).size,
    32,
  );
  assert.equal(vein.stoneBounds.max.y, -62);
  assert.equal(vein.stoneBounds.min.y <= -64, true);
  assert.equal(
    vein.bedrockBounds.max.y,
    vein.stoneBounds.min.y - 1,
  );
  assert.equal(
    vein.bedrockBounds.min.x < vein.stoneBounds.min.x,
    true,
  );
  assert.equal(
    vein.commands.some((command) =>
      command.text.includes("minecraft:iron_ore"),
    ),
    true,
  );
  assert.equal(
    vein.commands.some((command) =>
      command.text.includes("minecraft:coal_ore"),
    ),
    false,
  );

  const prior = new Set<string>();
  for (const [index, position] of vein.positions.entries()) {
    const adjacent = neighbors(position).some((neighbor) =>
      prior.has(neighbor),
    );
    assert.equal(index === 0 || adjacent, true);
    prior.add(`${position.x},${position.y},${position.z}`);
  }
});

test("generator limits fail before returning a partial plan", () => {
  const tree = new TreeGenerator({
    arena,
    surfaceY: -61,
    feature: "minecraft:oak",
    exclusionRadius: 4,
    footprintRadius: 4,
    maxHeight: 12,
    random: new LcgRandom(1),
  });
  const forest = new ForestGenerator({
    treeGenerator: tree,
    maxTrees: 2,
    maxRadius: 10,
    spacing: 5,
  });
  assert.throws(
    () => forest.generate({ x: 0, y: -60, z: 0 }, 3, 10),
    /between 1 and 2/,
  );

  const ore = new OreVeinGenerator({
    arena,
    surfaceY: -61,
    maxVeinSize: 8,
    fill: new FillCommandGenerator(32_768),
    random: new LcgRandom(1),
  });
  assert.throws(
    () => ore.generate({ x: 0, y: -60, z: 0 }, "coal", 9),
    /between 1 and 8/,
  );
});

class LcgRandom implements RandomSource {
  constructor(private state: number) {}

  next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

function neighbors(position: {
  x: number;
  y: number;
  z: number;
}): string[] {
  return [
    `${position.x + 1},${position.y},${position.z}`,
    `${position.x - 1},${position.y},${position.z}`,
    `${position.x},${position.y + 1},${position.z}`,
    `${position.x},${position.y - 1},${position.z}`,
    `${position.x},${position.y},${position.z + 1}`,
    `${position.x},${position.y},${position.z - 1}`,
  ];
}
