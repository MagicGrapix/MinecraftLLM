import assert from "node:assert/strict";
import test from "node:test";
import { configureCapabilitySafeMovements } from "../../../src/runtime/MinecraftRuntime";

test("idle pathfinder baseline cannot dig or place outside a goto task", () => {
  const movements = {
    canDig: true,
    allow1by1towers: true,
    scafoldingBlocks: [1, 4],
  };

  configureCapabilitySafeMovements(movements);

  assert.equal(movements.canDig, false);
  assert.equal(movements.allow1by1towers, false);
  assert.deepEqual(movements.scafoldingBlocks, []);
});
