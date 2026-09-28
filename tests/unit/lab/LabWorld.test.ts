import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../../../src/execution/Task";
import { LabExecutor } from "../../../src/lab/LabExecutor";
import { defaultLabScenario } from "../../../src/lab/LabScenario";
import { LabWorld } from "../../../src/lab/LabWorld";

function task(capability: string, input: unknown): Task {
  return { id: "test", createdAt: 0, capability, input };
}

test("the mock world changes only after an approved action", async () => {
  const world = new LabWorld(defaultLabScenario);
  const executor = new LabExecutor(world);
  const log = { x: 3, y: -60, z: 0 };
  const execution = executor.execute(task("dig", { position: log }));

  assert.equal(world.getBlock(log)?.name, "oak_log");
  assert.equal(world.getInventory().items.find((item) => item.name === "oak_log")?.count, 1);
  assert.equal(executor.pendingTask()?.capability, "dig");

  assert.equal(executor.approve()?.ok, true);
  assert.equal((await execution).ok, true);
  assert.equal(world.getBlock(log)?.name, "air");
  assert.equal(world.getInventory().items.find((item) => item.name === "oak_log")?.count, 2);
});

test("an injected failure leaves the world unchanged", async () => {
  const world = new LabWorld(defaultLabScenario);
  const executor = new LabExecutor(world);
  const log = { x: 3, y: -60, z: 0 };
  const execution = executor.execute(task("dig", { position: log }));

  const injected = executor.reject("OUT_OF_REACH", "Too far away in this scenario.");
  assert.equal(injected?.ok, false);
  assert.deepEqual(await execution, injected);
  assert.equal(world.getBlock(log)?.name, "oak_log");
  assert.equal(world.getInventory().items.find((item) => item.name === "oak_log")?.count, 1);
});

test("approve simulates equipping and placing a block against the ground", async () => {
  const world = new LabWorld(defaultLabScenario);
  const executor = new LabExecutor(world);
  const equip = executor.execute(task("equip", { item: "oak_log" }));
  assert.equal(executor.approve()?.ok, true);
  assert.equal((await equip).ok, true);

  const place = executor.execute(task("place", {
    referencePosition: { x: 1, y: -61, z: 0 },
    face: "top",
  }));
  assert.equal(executor.approve()?.ok, true);
  assert.equal((await place).ok, true);
  assert.equal(world.getBlock({ x: 1, y: -60, z: 0 })?.name, "oak_log");
  assert.equal(world.getInventory().items.find((item) => item.name === "oak_log"), undefined);
});

test("abort releases the pending checkpoint without changing the world", async () => {
  const world = new LabWorld(defaultLabScenario);
  const executor = new LabExecutor(world);
  const execution = executor.execute(task("goto", { position: { x: 2, y: -60, z: 0 } }));

  assert.equal(executor.abortCurrent("Stopped."), true);
  const result = await execution;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INTERRUPTED");
  assert.deepEqual(world.getSelf().position, defaultLabScenario.self.position);
  assert.equal(executor.pendingTask(), null);
});
