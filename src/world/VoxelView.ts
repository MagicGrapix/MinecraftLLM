import type { Position } from "../shared/types";
import type { WorldQueries } from "./WorldQueries";
import type { BlockInfo, SelfState } from "./types";

export type VoxelViewCenter =
  | { kind: "self" }
  | { kind: "position"; position: Position };

export interface VoxelOffset {
  dx: number;
  dy: number;
  dz: number;
}

export interface VoxelViewInput {
  center: VoxelViewCenter;
  focus?: VoxelOffset;
}

export interface VoxelView {
  center: Position;
  centerKind: VoxelViewCenter["kind"];
  bot: {
    position: Position;
    facing: SelfState["facing"];
    offset: VoxelOffset;
  };
  xOffsets: readonly number[];
  zOffsets: readonly number[];
  layers: readonly {
    dy: number;
    y: number;
    rows: readonly string[];
  }[];
  legend: Record<string, string>;
  focus?: {
    offset: VoxelOffset;
    position: Position;
    symbol: string;
    block: { name: string; boundingBox: string } | null;
  };
}

const horizontalOffsets = [-2, -1, 0, 1, 2] as const;
const verticalOffsets = [-1, 0, 1, 2] as const;
const fixedSymbols: Readonly<Record<string, string>> = {
  air: ".",
  grass_block: "G",
  dirt: "D",
  stone: "S",
  oak_log: "L",
  oak_leaves: "F",
  water: "W",
  bedrock: "B",
};
const fallbackSymbols = [..."ACEHIJKMNOPQRTUVXYZacehijkmnopqrtuvxyz0123456789"];

interface SampledCell {
  offset: VoxelOffset;
  block: BlockInfo | null;
}

export function buildVoxelView(
  world: WorldQueries,
  input: VoxelViewInput,
  self: SelfState = world.getSelf(),
): VoxelView {
  const feet = floorPosition(self.position);
  const center = input.center.kind === "self"
    ? feet
    : { ...input.center.position };
  const cells: SampledCell[] = [];

  for (const dy of verticalOffsets) {
    for (const dz of horizontalOffsets) {
      for (const dx of horizontalOffsets) {
        const offset = { dx, dy, dz };
        cells.push({
          offset,
          block: world.getBlock(atOffset(center, offset)),
        });
      }
    }
  }

  const presentNames = [...new Set(cells.flatMap(({ block }) => block ? [block.name] : []))]
    .sort();
  const symbols = new Map<string, string>();
  let fallbackIndex = 0;
  for (const name of presentNames) {
    symbols.set(name, fixedSymbols[name] ?? fallbackSymbols[fallbackIndex++] ?? `X${fallbackIndex}`);
  }

  const symbolOf = (block: BlockInfo | null): string =>
    block === null ? "?" : symbols.get(block.name) ?? "?";
  const legend: Record<string, string> = {};
  if (cells.some(({ block }) => block === null)) legend["?"] = "unknown/unloaded";
  for (const name of presentNames) {
    const symbol = symbols.get(name);
    if (symbol) legend[symbol] = name;
  }

  const layers = verticalOffsets.map((dy) => ({
    dy,
    y: center.y + dy,
    rows: horizontalOffsets.map((dz) =>
      horizontalOffsets.map((dx) => {
        const cell = cells.find((candidate) =>
          candidate.offset.dx === dx &&
          candidate.offset.dy === dy &&
          candidate.offset.dz === dz);
        return symbolOf(cell?.block ?? null);
      }).join(" ")),
  }));

  const focus = input.focus === undefined
    ? undefined
    : (() => {
        const cell = cells.find((candidate) =>
          candidate.offset.dx === input.focus?.dx &&
          candidate.offset.dy === input.focus?.dy &&
          candidate.offset.dz === input.focus?.dz);
        const block = cell?.block ?? null;
        return {
          offset: { ...input.focus },
          position: atOffset(center, input.focus),
          symbol: symbolOf(block),
          block: block ? { name: block.name, boundingBox: block.boundingBox } : null,
        };
      })();

  return {
    center,
    centerKind: input.center.kind,
    bot: {
      position: { ...self.position },
      facing: self.facing,
      offset: {
        dx: feet.x - center.x,
        dy: feet.y - center.y,
        dz: feet.z - center.z,
      },
    },
    xOffsets: horizontalOffsets,
    zOffsets: horizontalOffsets,
    layers,
    legend,
    ...(focus ? { focus } : {}),
  };
}

function floorPosition(position: Position): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
}

function atOffset(center: Position, offset: VoxelOffset): Position {
  return {
    x: center.x + offset.dx,
    y: center.y + offset.dy,
    z: center.z + offset.dz,
  };
}
