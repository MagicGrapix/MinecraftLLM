import type { Position } from "../shared/types";

export interface SelfState {
  position: Position;
  facing: "north" | "south" | "east" | "west";
  health: number;
  food: number;
  foodSaturation: number;
  oxygenLevel: number;
  onGround: boolean;
}

export interface InventoryItemInfo {
  name: string;
  displayName: string;
  type: number;
  metadata: number;
  count: number;
  slot: number;
}

export interface InventoryState {
  items: InventoryItemInfo[];
  selectedItem: InventoryItemInfo | null;
}

export interface BlockInfo {
  name: string;
  displayName: string;
  type: number;
  position: Position;
  boundingBox: string;
}

export interface EntityInfo {
  id: number;
  name: string | null;
  type: string;
  username: string | null;
  position: Position;
  distance: number;
  droppedItem: {
    name: string;
    displayName: string;
    count: number;
  } | null;
}

export interface FindBlocksOptions {
  maxDistance?: number;
  count?: number;
}

/** A loose item entity; null stack fields mean its metadata is not known yet. */
export interface DroppedItemInfo {
  id: number;
  item: string | null;
  count: number | null;
  position: Position;
  distance: number;
}

export interface NearbyEntitiesOptions {
  maxDistance?: number;
  type?: string;
}
