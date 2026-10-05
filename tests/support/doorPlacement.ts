import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { DoorPlacement } from "../../src/building/Blueprint";
import { TestBuildOperations } from "./building";

/** Fake native placement and inbound packets; no Mineflayer connection. */
export function doorPlacementHarness(door: DoorPlacement) {
  const ops = new TestBuildOperations(), client = new EventEmitter();
  let placed = 0;
  const fake = Object.assign(new EventEmitter(), {
    _client: client, heldItem: { name: "oak_door" }, blockAt: (p: Vec3) => ops.blockAt(p),
    look: async (_yaw: number, _pitch: number, force: boolean) => { assert.equal(force, false, "Must wait until rotation is sent"); },
    _placeBlockWithOptions: async (_block: unknown, _face: Vec3, options: { forceLook: string; delta: Vec3 }) => {
      assert.equal(options.forceLook, "ignore"); assert.deepEqual(options.delta, new Vec3(0.25, 1, 0.5));
      placed++; await ops.placeDoor(door);
      for (const y of [0, 1]) client.emit("block_change", { location: new Vec3(0, y, 0), type: 1 });
    },
  });
  return { fake, bot: fake as unknown as Bot, client, ops, placed: () => placed };
}
