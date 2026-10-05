import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { DoorPlacement } from "../../../src/building/Blueprint";
import { placeBuildDoor } from "../../../src/building/PlaceBuildDoor";
import { doorPlacementHarness } from "../../support/doorPlacement";

const door: DoorPlacement = { kind: "place_door", position: { x: 0, y: 0, z: 0 }, block: "oak_door", item: "oak_door", facing: "north", hinge: "left" };
const harness = () => doorPlacementHarness(door);
test("door adapter confirms both server halves and releases listeners", async () => {
  const h = harness();
  const result = await placeBuildDoor(h.bot, h.ops, door, new AbortController().signal);
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(h.placed(), 1);
  assert.equal(h.client.listenerCount("block_change"), 0); assert.equal(h.fake.listenerCount("end"), 0);
});
test("a predicted upper half without its server update is not confirmation", async () => {
  const h = harness();
  h.fake._placeBlockWithOptions = async () => {
    await h.ops.placeDoor(door);
    h.client.emit("block_change", { location: new Vec3(0, 0, 0), type: 1 });
  };
  const result = await placeBuildDoor(h.bot, h.ops, door, new AbortController().signal);
  assert.ok(!result.ok); assert.equal(result.error.code, "ACTION_NOT_CONFIRMED");
  assert.equal(h.client.listenerCount("block_change"), 0);
});
test("stop during rotation prevents sending the door placement", async () => {
  const h = harness(), abort = new AbortController();
  h.fake.look = async () => { abort.abort(new Error("stopped")); };
  await assert.rejects(placeBuildDoor(h.bot, h.ops, door, abort.signal), /stopped/);
  assert.equal(h.placed(), 0); assert.equal(h.client.listenerCount("block_change"), 0);
});
test("changed upper cell during rotation prevents placement", async () => {
  const h = harness(); h.fake.look = async () => { h.ops.set({ x: 0, y: 1, z: 0 }, "stone"); };
  const result = await placeBuildDoor(h.bot, h.ops, door, new AbortController().signal);
  assert.ok(!result.ok); assert.equal(result.error.code, "WORLD_CHANGED"); assert.equal(h.placed(), 0);
});
test("server rejection is structured and does not retry or keep listeners", async () => {
  const h = harness(); h.fake._placeBlockWithOptions = async () => { throw new Error("refused"); };
  const result = await placeBuildDoor(h.bot, h.ops, door, new AbortController().signal);
  assert.ok(!result.ok); assert.equal(result.error.facts?.cause, "refused"); assert.equal(h.client.listenerCount("block_change"), 0);
});
