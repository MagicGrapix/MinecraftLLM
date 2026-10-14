import { normalizeMinecraftName } from "../shared/helper";

export type MaterialKind = "block" | "item";

/** Structural subset shared by minecraft-data and the connected Mineflayer registry. */
export interface MaterialRegistry {
  readonly version: { readonly minecraftVersion?: string };
  readonly blocksByName: Readonly<Record<string, { readonly name: string; readonly boundingBox: string }>>;
  readonly itemsByName: Readonly<Record<string, { readonly name: string }>>;
}

export interface MaterialMatch {
  readonly name: string;
  readonly kind: MaterialKind;
}

export interface MaterialSearchResult {
  readonly minecraftVersion: string;
  readonly exact: MaterialMatch | null;
  readonly suggestions: readonly MaterialMatch[];
}

/** Offline names only: no inference about inventory, recipes or world availability. */
export class MaterialCatalog {
  readonly minecraftVersion: string;
  private readonly names: Record<MaterialKind, ReadonlySet<string>>;
  private readonly fullBlocks: ReadonlySet<string>;

  constructor(registry: MaterialRegistry) {
    const version = registry.version.minecraftVersion;
    if (!version) throw new Error("The material registry must identify its Minecraft version.");
    this.minecraftVersion = version;
    this.names = {
      block: new Set(Object.keys(registry.blocksByName)),
      item: new Set(Object.keys(registry.itemsByName)),
    };
    this.fullBlocks = new Set(Object.entries(registry.blocksByName)
      .filter(([, block]) => block.boundingBox === "block").map(([name]) => name));
  }

  /** Same exact namespace handling as WorldQueries.isKnownName; no spelling corrections. */
  resolve(kind: MaterialKind, name: string): MaterialMatch | null {
    const canonical = normalizeMinecraftName(name);
    return this.names[kind].has(canonical) ? { name: canonical, kind } : null;
  }

  isFullBlock(name: string): boolean {
    return this.fullBlocks.has(normalizeMinecraftName(name));
  }

  search(query: string, kind: MaterialKind = "block"): MaterialSearchResult {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      throw new RangeError("Material search must contain between 1 and 128 characters.");
    }
    const exact = this.resolve(kind, trimmed);
    // Case/space normalization helps suggestions only; it must not create an exact match.
    const needle = normalizeMinecraftName(trimmed).toLowerCase().replace(/\s+/g, "_");
    const suggestions = exact ? [] : [...this.names[kind]]
      .map((name) => ({ name, score: relevance(needle, name) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || compareNames(a.name, b.name))
      .slice(0, 5)
      .map(({ name }) => ({ name, kind }));
    return { minecraftVersion: this.minecraftVersion, exact, suggestions };
  }
}

export function relevance(query: string, name: string): number {
  if (query === name) return 1_000;
  if (name.startsWith(query)) return 900;
  if (name.split("_").includes(query)) return 850;
  if (name.includes(query)) return 800;
  const words = new Set(query.split("_").filter(Boolean));
  const matched = [...words].filter((word) => name.split("_").includes(word)).length;
  const wordScore = words.size ? 300 * matched / words.size : 0;
  const maxDistance = Math.min(3, Math.floor(query.length * 0.35));
  const distance = Math.abs(query.length - name.length) <= maxDistance
    ? editDistance(query, name) : Infinity;
  const spellingScore = distance <= maxDistance ? 600 - distance * 50 : 0;
  return Math.max(wordScore, spellingScore);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length]!;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
