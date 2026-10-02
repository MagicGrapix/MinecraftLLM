import type { Position } from "../../shared/types";
import {
  boundsVolume,
  containsBounds,
  createArenaBounds,
  type ArenaBounds,
} from "../ArenaBounds";
import { DEV_WORLD_BLOCKS, ORE_BLOCKS, type OreKind } from "../BlockCatalog";
import { nextRandom, type RandomSource } from "../RandomSource";
import type { PlannedCommand } from "../WorldPlan";
import { FillCommandGenerator } from "./FillCommandGenerator";

export interface OreVeinGeneratorOptions {
  readonly arena: ArenaBounds;
  readonly surfaceY: number;
  readonly maxVeinSize: number;
  readonly fill: FillCommandGenerator;
  readonly random: RandomSource;
}

export interface PlannedOreVein {
  readonly kind: OreKind;
  readonly positions: readonly Position[];
  readonly stoneBounds: ArenaBounds;
  readonly bedrockBounds: ArenaBounds;
  readonly commands: readonly PlannedCommand[];
}

const neighbors = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
] as const;

export class OreVeinGenerator {
  constructor(private readonly options: OreVeinGeneratorOptions) {}

  generate(
    center: Position,
    kind: OreKind,
    size: number,
  ): PlannedOreVein {
    if (!(kind in ORE_BLOCKS)) {
      throw new Error(`Unsupported ore kind "${kind}".`);
    }
    if (
      !Number.isInteger(size) ||
      size <= 0 ||
      size > this.options.maxVeinSize
    ) {
      throw new Error(
        `Ore vein size must be between 1 and ${this.options.maxVeinSize}.`,
      );
    }

    const geometry = createPocketGeometry(
      center,
      size,
      this.options.surfaceY,
      this.options.arena.min.y,
    );
    if (
      !containsBounds(this.options.arena, geometry.stoneBounds) ||
      !containsBounds(this.options.arena, geometry.bedrockBounds)
    ) {
      throw new Error(
        "The protected stone pocket does not fit inside the configured arena.",
      );
    }

    const positions = this.generateConnectedVein(
      geometry.interiorBounds,
      size,
    );
    const commands: PlannedCommand[] = [
      ...this.options.fill.generate(
        geometry.stoneBounds,
        DEV_WORLD_BLOCKS.stone,
      ),
      ...this.options.fill.generate(
        geometry.bedrockBounds,
        DEV_WORLD_BLOCKS.bedrock,
      ),
      ...positions.map((position) => ({
        text: `setblock ${position.x} ${position.y} ${position.z} ${ORE_BLOCKS[kind]} replace`,
        estimatedBlocksChanged: 1,
        affectedBounds: createArenaBounds(position, position),
      })),
    ];

    return {
      kind,
      positions,
      stoneBounds: geometry.stoneBounds,
      bedrockBounds: geometry.bedrockBounds,
      commands,
    };
  }

  private generateConnectedVein(
    interior: ArenaBounds,
    size: number,
  ): Position[] {
    if (boundsVolume(interior) < size) {
      throw new Error("Ore pocket interior is too small.");
    }
    const start = {
      x: Math.floor((interior.min.x + interior.max.x) / 2),
      y: interior.max.y,
      z: Math.floor((interior.min.z + interior.max.z) / 2),
    };
    const positions: Position[] = [start];
    const keys = new Set([positionKey(start)]);

    // Grow only from the current boundary: connected, unique, and no random retry exhaustion.
    const frontier = new Map<string, Position>();
    const expand = (anchor: Position): void => {
      for (const offset of neighbors) {
        const candidate = { x: anchor.x + offset.x, y: anchor.y + offset.y, z: anchor.z + offset.z };
        const key = positionKey(candidate);
        if (containsPositionFast(interior, candidate) && !keys.has(key)) frontier.set(key, candidate);
      }
    };
    expand(start);
    while (positions.length < size) {
      const candidates = [...frontier.values()];
      if (!candidates.length) throw new Error("Ore pocket has no free neighboring cell.");
      const position = candidates[Math.floor(nextRandom(this.options.random, 0, candidates.length))]!;
      const key = positionKey(position);
      frontier.delete(key);
      keys.add(key);
      positions.push(position);
      expand(position);
    }
    return positions;
  }
}

function createPocketGeometry(
  center: Position,
  size: number,
  surfaceY: number,
  minWorldY: number,
): {
  interiorBounds: ArenaBounds;
  stoneBounds: ArenaBounds;
  bedrockBounds: ArenaBounds;
} {
  let width = Math.max(3, Math.ceil(Math.cbrt(size)) + 1);
  let interiorMaxY = surfaceY - 2;
  // The default superflat has only two dirt layers above bedrock at -64.
  // Use a wider shallow pocket there, never commands beneath build height.
  if (interiorMaxY < minWorldY + 2) interiorMaxY = surfaceY - 1;
  const availableDepth = interiorMaxY - (minWorldY + 2) + 1;
  if (availableDepth < 1) throw new Error("No room for ore, stone support and bedrock below the surface.");
  const depth = Math.min(availableDepth, Math.max(2, Math.ceil(size / (width * width))));
  width = Math.max(width, Math.ceil(Math.sqrt(size / depth)));
  const centerX = Math.round(center.x);
  const centerZ = Math.round(center.z);
  const minX = centerX - Math.floor(width / 2);
  const minZ = centerZ - Math.floor(width / 2);
  const interiorBounds = createArenaBounds(
    {
      x: minX,
      y: interiorMaxY - depth + 1,
      z: minZ,
    },
    {
      x: minX + width - 1,
      y: interiorMaxY,
      z: minZ + width - 1,
    },
  );
  const stoneBounds = createArenaBounds(
    {
      x: interiorBounds.min.x - 1,
      y: interiorBounds.min.y - 1,
      z: interiorBounds.min.z - 1,
    },
    {
      x: interiorBounds.max.x + 1,
      y: surfaceY - 1,
      z: interiorBounds.max.z + 1,
    },
  );
  const bedrockY = stoneBounds.min.y - 1;
  const bedrockBounds = createArenaBounds(
    {
      x: stoneBounds.min.x - 1,
      y: bedrockY,
      z: stoneBounds.min.z - 1,
    },
    {
      x: stoneBounds.max.x + 1,
      y: bedrockY,
      z: stoneBounds.max.z + 1,
    },
  );
  return { interiorBounds, stoneBounds, bedrockBounds };
}

function containsPositionFast(
  bounds: ArenaBounds,
  position: Position,
): boolean {
  return (
    position.x >= bounds.min.x &&
    position.x <= bounds.max.x &&
    position.y >= bounds.min.y &&
    position.y <= bounds.max.y &&
    position.z >= bounds.min.z &&
    position.z <= bounds.max.z
  );
}

function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`;
}
