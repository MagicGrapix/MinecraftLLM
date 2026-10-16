import assert from "node:assert/strict";
import test from "node:test";
import {
  boundsVolume,
  containsBounds,
  createArenaBounds,
  intersectsBounds,
  unionBounds,
} from "../../../src/devworld/ArenaBounds";
import { DEV_WORLD_BLOCKS } from "../../../src/devworld/BlockCatalog";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { WorldPlanFactory } from "../../../src/devworld/WorldPlan";
import { FillCommandGenerator } from "../../../src/devworld/generators/FillCommandGenerator";
import { ResetArenaGenerator } from "../../../src/devworld/generators/ResetArenaGenerator";

const arena = createArenaBounds(
  { x: -48, y: -96, z: -48 },
  { x: 48, y: -30, z: 48 },
);

test("default arena remains within vanilla overworld build height", () => {
  const config = loadWorldBuilderConfig({});
  assert.equal(config.arena.min.y, -64);
  assert.throws(() => loadWorldBuilderConfig({ WORLD_ARENA_MIN_Y: "-96" }));
  assert.throws(() => loadWorldBuilderConfig({ WORLD_ARENA_MAX_Y: "320" }));
  const reset = new ResetArenaGenerator({ arena: config.arena, surfaceY: config.surfaceY, agentUsername: "bot", fill: new FillCommandGenerator(32768) });
  assert.ok(reset.generateReset().every((command) => !command.affectedBounds || command.affectedBounds.min.y >= -64));
});

test("arena bounds use inclusive volume and safe unions", () => {
  const first = createArenaBounds(
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 1 },
  );
  const second = createArenaBounds(
    { x: 1, y: 1, z: 1 },
    { x: 3, y: 2, z: 2 },
  );

  assert.equal(boundsVolume(first), 8);
  assert.equal(intersectsBounds(first, second), true);
  assert.deepEqual(unionBounds(first, second), {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 3, y: 2, z: 2 },
  });
  assert.equal(containsBounds(unionBounds(first, second), first), true);
});

test("controller defaults to two commands per second and permits a slower fallback", () => {
  assert.equal(loadWorldBuilderConfig({}).commandsPerSecond, 2);
  assert.equal(loadWorldBuilderConfig({ WORLD_COMMANDS_PER_SECOND: "1" }).commandsPerSecond, 1);
  assert.throws(
    () =>
      loadWorldBuilderConfig({
        WORLD_COMMANDS_PER_SECOND: "8",
      }),
    /less than or equal to 2/,
  );
});

test("fill splitting preserves exact volume below the command cap", () => {
  const generator = new FillCommandGenerator(32_768);
  const commands = generator.generate(arena, DEV_WORLD_BLOCKS.air);

  assert.equal(commands.length > 1, true);
  assert.equal(
    commands.every(
      (command) =>
        command.text.endsWith(" minecraft:air replace") &&
        command.estimatedBlocksChanged! <= 32_768,
    ),
    true,
  );
  assert.equal(
    commands.reduce(
      (total, command) =>
        total + command.estimatedBlocksChanged!,
      0,
    ),
    boundsVolume(arena),
  );
});

test("reset restores exact flat layers and clear preserves underground", () => {
  const reset = new ResetArenaGenerator({
    arena,
    surfaceY: -61,
    agentUsername: "bot",
    fill: new FillCommandGenerator(32_768),
  });
  const commands = reset.generateReset();
  const texts = commands.map((command) => command.text);

  assert.match(
    texts[0]!,
    /^kill @e\[type=!minecraft:player,x=-48,y=-96,z=-48,dx=96,dy=66,dz=96\]$/,
  );
  assert.equal(
    texts.some(
      (text) =>
        text ===
        "fill -48 -64 -48 48 -64 48 minecraft:bedrock replace",
    ),
    true,
  );
  assert.equal(
    texts.some((text) =>
      text.endsWith("-63 48 minecraft:dirt replace"),
    ),
    true,
  );
  assert.equal(
    texts.some((text) =>
      text.endsWith("-62 48 minecraft:dirt replace"),
    ),
    true,
  );
  assert.equal(
    texts.some((text) =>
      text.endsWith("-61 48 minecraft:grass_block replace"),
    ),
    true,
  );
  assert.equal(texts.includes("clear bot"), true);
  assert.equal(texts.includes("effect clear bot"), true);
  assert.equal(texts.includes("gamemode survival bot"), true);
  assert.equal(texts.includes("tp bot 0 -60 0"), true);

  const clear = reset.generateClear();
  const fillCommands = clear.filter((command) =>
    command.text.startsWith("fill "),
  );
  assert.equal(
    fillCommands.every(
      (command) => command.affectedBounds!.min.y >= -60,
    ),
    true,
  );
});

for (const { surfaceY, resetArena, maxFillBlocks } of [
  { surfaceY: -61, resetArena: loadWorldBuilderConfig({}).arena, maxFillBlocks: 32_768 },
  {
    surfaceY: 10,
    resetArena: createArenaBounds({ x: -2, y: 7, z: -2 }, { x: 2, y: 13, z: 2 }),
    maxFillBlocks: 16,
  },
]) {
  test(`terrain reset covers dirt before placing it at surface Y=${surfaceY}`, () => {
    const reset = new ResetArenaGenerator({
      arena: resetArena,
      surfaceY,
      agentUsername: "bot",
      fill: new FillCommandGenerator(maxFillBlocks),
    });
    const commands = reset.generateTerrainReset();
    const fills = commands.filter(command => command.text.startsWith("fill "));
    const layers = [
      { y: surfaceY, block: DEV_WORLD_BLOCKS.grass },
      { y: surfaceY - 1, block: DEV_WORLD_BLOCKS.dirt },
      { y: surfaceY - 2, block: DEV_WORLD_BLOCKS.dirt },
      { y: surfaceY - 3, block: DEV_WORLD_BLOCKS.bedrock },
    ];
    const airFills = fills.filter(command => command.text.endsWith(` ${DEV_WORLD_BLOCKS.air} replace`));
    let offset = airFills.length;
    assert.deepEqual(fills.slice(0, offset), airFills, "Clear all cells before rebuilding any layer");

    for (const { y, block } of layers) {
      const expected = new FillCommandGenerator(maxFillBlocks).generate(
        createArenaBounds(
          { x: resetArena.min.x, y, z: resetArena.min.z },
          { x: resetArena.max.x, y, z: resetArena.max.z },
        ),
        block,
      );
      assert.deepEqual(
        fills.slice(offset, offset + expected.length), expected,
        `Complete the entire layer at Y=${y} before placing the layer below`,
      );
      offset += expected.length;
    }
    assert.equal(offset, fills.length, "Do not clear or rebuild layers again afterwards");
    assert.match(commands[0]!.text, /^kill /);
    assert.match(commands.at(-1)!.text, /^kill /);
  });
}

test("world plan validation rejects unsafe text and out-of-arena effects", () => {
  const factory = new WorldPlanFactory({
    arena,
    maxPlanCommands: 2,
    createId: () => "plan-1",
  });
  const safe = factory.create("safe", [
    {
      text: "setblock 0 -60 0 minecraft:stone replace",
      estimatedBlocksChanged: 1,
      affectedBounds: createArenaBounds(
        { x: 0, y: -60, z: 0 },
        { x: 0, y: -60, z: 0 },
      ),
    },
  ]);
  assert.equal(safe.id, "plan-1");

  assert.throws(
    () =>
      factory.create("unsafe", [
        {
          text: "/say no",
          affectedBounds: safe.affectedBounds,
        },
      ]),
    /omit "\/"/,
  );
  assert.throws(
    () =>
      factory.create("outside", [
        {
          text: "setblock 100 -60 0 minecraft:stone",
          affectedBounds: createArenaBounds(
            { x: 100, y: -60, z: 0 },
            { x: 100, y: -60, z: 0 },
          ),
        },
      ]),
    /outside/,
  );
});
