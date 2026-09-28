import assert from "node:assert/strict";
import test from "node:test";
import { formatWorldContext } from "../../../src/agent/WorldContextFormatter";

test("world context aggregates item stacks, keeps exact positions and landmark status, and excludes metadata", () => {
  const item = { name: "oak_log", displayName: "Oak Log", type: 134, metadata: 0, count: 2, slot: 36 };
  const result = formatWorldContext({
    self: { position: { x: 2.9999, y: -60, z: -0.0001 }, facing: "east", health: 18, food: 17, foodSaturation: 3, oxygenLevel: 20, onGround: true },
    inventory: { items: [item, { ...item, count: 3, slot: 37 }], selectedItem: item },
    landmarks: [{ id: "internal-id", name: "Table", kind: "crafting_table", dimension: "overworld", position: { x: 5, y: -60, z: 2 }, status: "stale", source: "observed", pinned: true, createdAt: 123456, lastVerifiedAt: 789123 }],
  });
  assert.match(result, /Position: \(2\.9999, -60, -0\.0001\); facing east/);
  assert.match(result, /Inventory: oak_log x5\./);
  assert.match(result, /Held item: oak_log/);
  assert.match(result, /crafting_table at \(5, -60, 2\) in overworld; stale/);
  assert.doesNotMatch(result, /slot|metadata|displayName|internal-id|123456|789123|```/);
  assert.equal(item.count, 2);
});
