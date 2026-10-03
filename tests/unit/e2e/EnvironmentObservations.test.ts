import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { loadWorldBuilderConfig } from "../../../src/devworld/WorldBuilderConfig";
import { environmentPlan, environmentReady, observeDrops } from "../../e2e/EnvironmentObservations";
import { blockFixture } from "../../e2e/ScenarioFixtures";

const config = loadWorldBuilderConfig({});
const position = { x: 3, y: -60, z: 0 };

test("environment setup uses bounded vanilla commands, actual stacks and persistent dropped items", () => {
  const plan = environmentPlan(config, [{ position, items: { oak_log: 4 } }], [{ position: { x: 5.5, y: -60, z: 0.5 }, item: "oak_log", count: 4 }])!;
  assert.equal(plan.commands[0]!.text, "item replace block 3 -60 0 container.0 with minecraft:oak_log 4");
  assert.match(plan.commands[1]!.text, /summon minecraft:item 5.5 -60 0.5/);
  assert.match(plan.commands[1]!.text, /count:4/);
  assert.match(plan.commands[1]!.text, /PickupDelay:0s,Age:-32768s/);
  assert.match(plan.commands[1]!.text, /Motion:\[0\.0d,0\.0d,0\.0d\]/);
  assert.equal(environmentPlan(config, [], []), null);
  assert.throws(() => environmentPlan(config, [{ position: { ...position, x: 900 }, items: { oak_log: 4 } }], []), /outside/);
  assert.throws(() => environmentPlan(config, [], [{ position, item: "oak_log\nkill", count: 4 }]), /Invalid/);
  assert.throws(() => environmentPlan(config, [], [{ position, item: "oak_log", count: 0 }]), /Invalid/);
});

test("setup waits for exact chest contents and nearby item metadata rather than assuming commands succeeded", () => {
  const containers = [{ position, items: { oak_log: 4 } }];
  const drops = [{ position: { x: 5.5, y: -60, z: 0.5 }, item: "oak_log", count: 4 }];
  const observed = { containers: [{ position, inventory: { oak_log: 4 } }], drops };
  assert.equal(environmentReady(observed, containers, drops), true);
  assert.equal(environmentReady({ ...observed, containers: [{ position, inventory: null }] }, containers, drops), false);
  assert.equal(environmentReady({ ...observed, drops: [] }, containers, drops), false);
  assert.equal(environmentReady({ ...observed, drops: [{ ...drops[0]!, count: null }] }, containers, drops), false);
  assert.equal(environmentReady({ ...observed, drops: [{ ...drops[0]!, position }] }, containers, drops), false);
  assert.equal(environmentReady(observed, [{ position, items: { oak_log: 2 } }], drops), false);
});

test("dropped observations exclude players and entities outside arena and preserve unknown stack metadata", () => {
  const item = (x: number, stack: unknown) => ({ name: "item", position: new Vec3(x, -60, 0.5), getDroppedItem: () => stack });
  const bot = { entities: { 1: item(5, { name: "oak_log", count: 4 }), 2: item(6, null), 3: item(100, { name: "oak_log", count: 4 }),
    4: { name: "player", position: new Vec3(5, -60, 0.5) } } } as unknown as Pick<Bot, "entities">;
  assert.deepEqual(observeDrops(bot, config).map(({ item, count }) => ({ item, count })), [{ item: "oak_log", count: 4 }, { item: null, count: null }]);
});

test("fixed block geometry shares its expected cells and bounded efficient fill commands", () => {
  const result = blockFixture(config, "Test wall", [{ min: position, max: { ...position, y: -58 }, name: "stone" }]);
  assert.equal(result.plan.commands.length, 1);
  assert.equal(result.blocks.length, 3);
  assert.equal(result.plan.estimatedBlocksChanged, 3);
  assert.throws(() => blockFixture(config, "Outside", [{ min: position, max: { ...position, x: 100 }, name: "stone" }]), /outside/);
  assert.throws(() => blockFixture({ ...config, maxFillBlocks: 1 }, "Too big", [{ min: position, max: { ...position, x: 5 }, name: "stone" }]), /fill limit/);
});
