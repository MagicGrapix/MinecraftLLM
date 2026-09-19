import type { Position } from "../shared/types";
import type {
  BlockInfo,
  EntityInfo,
  FindBlocksOptions,
  InventoryState,
  NearbyEntitiesOptions,
  SelfState,
} from "./types";

export interface WorldQueries {
  getSelf(): SelfState;
  getInventory(): InventoryState;
  getBlock(position: Position): BlockInfo | null;
  findNearestBlocks(
    names: string | readonly string[],
    options?: FindBlocksOptions,
  ): BlockInfo[];
  getNearbyEntities(options?: NearbyEntitiesOptions): EntityInfo[];
}
