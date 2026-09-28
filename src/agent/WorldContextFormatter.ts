import type { Landmark } from "../memory/LandmarkMemory";
import type { Position } from "../shared/types";
import type { InventoryState, SelfState } from "../world/types";

export interface WorldContextSnapshot {
  readonly self: SelfState;
  readonly inventory: InventoryState;
  readonly landmarks: readonly Landmark[];
}

/** Prompt projection only: keep the complete snapshot in the inspector. */
export function formatWorldContext(world: WorldContextSnapshot): string {
  const { self, inventory, landmarks } = world;
  const totals = new Map<string, number>();
  for (const item of inventory.items) {
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }
  const items = [...totals].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} x${count}`).join(", ");
  return [
    `Position: ${position(self.position)}; facing ${self.facing}; on ground: ${self.onGround ? "yes" : "no"}.`,
    `Health: ${self.health}/20; food: ${self.food}/20; saturation: ${self.foodSaturation}; oxygen: ${self.oxygenLevel}.`,
    `Inventory: ${items || "empty"}.`,
    `Held item: ${inventory.selectedItem?.name ?? "none"}.`,
    landmarks.length === 0 ? "Known places: none." : "Known places:",
    ...landmarks.map((landmark) =>
      `- ${JSON.stringify(landmark.name)}: ${landmark.kind} at ${position(landmark.position)} in ${landmark.dimension}; ${landmark.status}.`,
    ),
  ].join("\n");
}

function position(value: Position): string {
  // Retain exact coordinates: rounding near a block boundary can select another block.
  return `(${value.x}, ${value.y}, ${value.z})`;
}
