import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { firstTerrainMismatch, formatTerrainMismatch, type TerrainMismatch } from "../../e2e/TerrainVerification";
import { until } from "../../e2e/async";

const config = loadWorldBuilderConfig({
  WORLD_ARENA_MIN_X: "-1", WORLD_ARENA_MAX_X: "1",
  WORLD_ARENA_MIN_Z: "-1", WORLD_ARENA_MAX_Z: "1", WORLD_ARENA_MAX_Y: "-59",
});

test("terrain verification scans every cell of a matching superflat arena", () => {
  let cells = 0;
  const bot = terrainBot(position => { cells++; return flatBlock(position); });
  assert.equal(firstTerrainMismatch(bot, config, []), null);
  assert.equal(cells, 54);
});

test("terrain verification returns only the first incorrect cell with expected and observed blocks", () => {
  let cells = 0;
  const bot = terrainBot(position => {
    cells++;
    return position.y === -63 ? "stone" : flatBlock(position);
  });
  const mismatch = firstTerrainMismatch(bot, config, []);
  assert.deepEqual(mismatch, {
    kind: "block", position: { x: -1, y: -63, z: -1 }, expected: "dirt", observed: "stone",
  });
  assert.equal(cells, 2, "Stops after one anomaly, not a dump of all incorrect cells.");
  assert.equal(formatTerrainMismatch(mismatch!), "First mismatch at (-1, -63, -1): expected dirt; observed stone.");
});

test("unavailable chunks remain unknown instead of becoming air", () => {
  const mismatch = firstTerrainMismatch(terrainBot(() => null), config, []);
  assert.deepEqual(mismatch, {
    kind: "block", position: { x: -1, y: -64, z: -1 }, expected: "bedrock", observed: null,
  });
  assert.match(formatTerrainMismatch(mismatch!), /observed unknown \(block\/chunk unavailable\)/);
});

test("fixture verification accepts expected additions and still checks the surrounding arena", () => {
  const position = { x: 0, y: -60, z: 0 };
  const bot = terrainBot(p => p.equals(new Vec3(0, -60, 0)) ? "oak_log" : flatBlock(p));
  assert.equal(firstTerrainMismatch(bot, config, [{ position, name: "oak_log" }]), null);
  assert.deepEqual(firstTerrainMismatch(bot, config, []), {
    kind: "block", position, expected: "air", observed: "oak_log",
  });
});

test("unexpected arena entities have a distinct diagnostic; players and outside entities are allowed", () => {
  const entities = {
    1: { id: 1, type: "player", position: new Vec3(0, -60, 0) },
    2: { id: 2, type: "other", name: "item", position: new Vec3(8, -60, 0) },
  } as unknown as Bot["entities"];
  const bot = terrainBot(flatBlock, entities);
  assert.equal(firstTerrainMismatch(bot, config, []), null);
  entities[3] = { id: 3, type: "other", name: "item", position: new Vec3(0.333333, -60, 0) } as unknown as Bot["entity"];
  const mismatch = firstTerrainMismatch(bot, config, []);
  assert.deepEqual(mismatch, {
    kind: "entity", entityId: 3, entityType: "other", name: "item", position: { x: 0.333333, y: -60, z: 0 },
  });
  assert.match(formatTerrainMismatch(mismatch!), /Unexpected entity #3 \(item\) at \(0.33, -60, 0\)/);
});

test("timeout details describe the final scan rather than the initial mismatch", async () => {
  let checks = 0;
  let mismatch: Extract<TerrainMismatch, { kind: "block" }> = { kind: "block", position: { x: 0, y: -61, z: 0 }, expected: "grass_block", observed: "dirt" };
  // Zero budget expires after checking once, so the callback still gets the latest observation.
  await assert.rejects(until(() => {
    checks++;
    mismatch = { ...mismatch, observed: "air" };
    return false;
  }, 0, "Superflat reset verification", undefined, () => formatTerrainMismatch(mismatch)),
  /Superflat reset verification timed out after 0 ms\. First mismatch at \(0, -61, 0\): expected grass_block; observed air/);
  assert.equal(checks, 1);
});

test("updates can settle during polling without evaluating or emitting timeout details", async () => {
  let checks = 0;
  await until(() => ++checks === 2, 2_000, "Fixture verification", undefined,
    () => assert.fail("Successful polling must not emit a failure diagnostic"));
  assert.equal(checks, 2);
});

test("cancellation and observation errors are not replaced by a terrain timeout", async () => {
  const abort = new AbortController();
  const error = new Error("Campaign cancelled");
  abort.abort(error);
  await assert.rejects(until(() => false, 0, "Reset", abort.signal,
    () => assert.fail("Cancellation is not a mismatch timeout")), cause => cause === error);
  await assert.rejects(until(() => { throw new Error("World controller died"); }, 0, "Reset", undefined,
    () => assert.fail("Observer failure is not a mismatch timeout")), /World controller died/);
});

function flatBlock(position: Vec3): string {
  return position.y === -64 ? "bedrock" : position.y === -63 || position.y === -62 ? "dirt"
    : position.y === -61 ? "grass_block" : "air";
}

function terrainBot(read: (position: Vec3) => string | null = flatBlock, entities: Bot["entities"] = {}): Pick<Bot, "entities" | "blockAt"> {
  return {
    entities,
    blockAt: position => {
      const name = read(position);
      return name === null ? null : { name };
    },
  } as Pick<Bot, "entities" | "blockAt">;
}
