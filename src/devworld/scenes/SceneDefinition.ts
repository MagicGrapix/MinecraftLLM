import type { Position } from "../../shared/types";

// Coordinates are local to the photo stage; y=0 is the grass surface.
export interface SceneRegion {
  readonly min: Position;
  readonly max: Position;
  readonly block: string;
}

export interface ScenePose {
  readonly position: Position;
  readonly yaw: number;
  readonly pitch: number;
}

export interface SceneDefinition {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly regions: readonly SceneRegion[];
  readonly actor: ScenePose & { readonly hand: string };
  readonly camera: ScenePose;
  readonly drops?: readonly { position: Position; item: string }[];
  readonly drawing?: string;
}

export function region(block: string, x: number, y: number, z: number,
  maxX = x, maxY = y, maxZ = z): SceneRegion {
  return { block, min: { x, y, z }, max: { x: maxX, y: maxY, z: maxZ } };
}

/** Fixed silhouette, not /place feature; leaves are made persistent by ScenePlan. */
export function fixedOak(x: number, z: number): SceneRegion[] {
  return [
    region("oak_leaves", x - 2, 3, z - 1, x + 2, 4, z + 1),
    region("oak_leaves", x - 1, 3, z - 2, x + 1, 4, z + 2),
    region("oak_leaves", x - 1, 5, z - 1, x + 1, 5, z + 1),
    region("oak_log", x, 1, z, x, 4, z),
  ];
}
