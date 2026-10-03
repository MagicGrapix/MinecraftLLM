import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { containsPosition } from "../../src/devworld/ArenaBounds";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import type { Position } from "../../src/shared/types";

export interface ExpectedBlock { readonly position: Position; readonly name: string }

export type TerrainMismatch =
  | { readonly kind: "block"; readonly position: Position; readonly expected: string; readonly observed: string | null }
  | { readonly kind: "entity"; readonly position: Position; readonly entityId: number; readonly entityType: string; readonly name: string | null };

/** Return only the first anomaly in the current scan; unknown blocks are never air. */
export function firstTerrainMismatch(
  bot: Pick<Bot, "entities" | "blockAt">,
  config: Pick<WorldBuilderConfig, "arena" | "surfaceY">,
  blocks: readonly ExpectedBlock[],
): TerrainMismatch | null {
  const entity = Object.values(bot.entities).find(entity =>
    entity.type !== "player" && containsPosition(config.arena, entity.position));
  if (entity) return {
    kind: "entity", entityId: entity.id, entityType: entity.type, name: entity.name ?? null,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
  };

  const overrides = new Map(blocks.map(block => [key(block.position), block.name]));
  const { arena, surfaceY } = config;
  for (let x = arena.min.x; x <= arena.max.x; x++) {
    for (let z = arena.min.z; z <= arena.max.z; z++) {
      for (let y = arena.min.y; y <= arena.max.y; y++) {
        const position = { x, y, z };
        const expected = overrides.get(key(position)) ?? (y === surfaceY ? "grass_block"
          : y === surfaceY - 1 || y === surfaceY - 2 ? "dirt"
          : y === surfaceY - 3 ? "bedrock" : "air");
        const observed = bot.blockAt(new Vec3(x, y, z))?.name ?? null;
        if (observed !== expected) return { kind: "block", position, expected, observed };
      }
    }
  }
  return null;
}

export function formatTerrainMismatch(mismatch: TerrainMismatch): string {
  const position = `(${[mismatch.position.x, mismatch.position.y, mismatch.position.z]
    .map(value => Number(value.toFixed(2))).join(", ")})`;
  if (mismatch.kind === "entity") return `Unexpected entity #${mismatch.entityId} (${mismatch.name ?? mismatch.entityType}) at ${position}; expected no non-player entities in the arena.`;
  return `First mismatch at ${position}: expected ${mismatch.expected}; observed ${mismatch.observed ?? "unknown (block/chunk unavailable)"}.`;
}

function key(position: Position): string { return `${position.x},${position.y},${position.z}`; }
