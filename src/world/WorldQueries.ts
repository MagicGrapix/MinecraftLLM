import type { Position } from "../shared/types";
import type { BlockAccessInfo } from "./BlockAccess";
import type {
  BlockInfo,
  EntityInfo,
  FindBlocksOptions,
  InventoryState,
  NearbyEntitiesOptions,
  SelfState,
} from "./types";

export interface WorldQueries {
  isKnownName(kind: "block" | "item", name: string): boolean;
  getSelf(): SelfState;
  getInventory(): InventoryState;
  getBlock(position: Position): BlockInfo | null;
  getBlockAccess(position: Position): BlockAccessInfo;
  findNearestBlocks(
    names: string | readonly string[],
    options?: FindBlocksOptions,
  ): BlockInfo[];
  getNearbyEntities(options?: NearbyEntitiesOptions): EntityInfo[];
}
