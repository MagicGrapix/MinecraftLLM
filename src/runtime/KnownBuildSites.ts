import type { MinecraftRuntime } from "./MinecraftRuntime";
import type { Position } from "../shared/types";

interface Site { dimension: string; min: Position; max: Position }
const sites = new WeakMap<MinecraftRuntime, Map<string, Site>>();

/** Session-local sites explicitly handed to build; not automatic recognition of player buildings. */
export function rememberBuildSite(runtime: MinecraftRuntime, dimension: string, origin: Position, width: number, height: number, depth: number): void {
  let known = sites.get(runtime);
  if (!known) { known = new Map(); sites.set(runtime, known); }
  known.set(JSON.stringify([dimension, origin]), { dimension,
    min: { x: origin.x - 2, y: origin.y - 1, z: origin.z - 2 },
    max: { x: origin.x + width + 1, y: origin.y + height, z: origin.z + depth + 1 } });
}

export function isKnownBuildCell(runtime: MinecraftRuntime, dimension: string, p: Position): boolean {
  return [...(sites.get(runtime)?.values() ?? [])].some(s => s.dimension === dimension &&
    p.x >= s.min.x && p.x <= s.max.x && p.y >= s.min.y && p.y <= s.max.y && p.z >= s.min.z && p.z <= s.max.z);
}
