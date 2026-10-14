import type { TaskResult } from "../execution/TaskResult";
import type { Position } from "../shared/types";
import type { Resource } from "./ResourceCatalog";

export interface CollectInput { item: string; quantity: number }
export interface CollectionSource { name: string; stateId: number; position: Position }
export interface CollectionDrop { id: number; count: number; position: Position }
export interface CollectionStock { count: number; capacity: number }
export interface CollectionProgress {
  item: string;
  requested: number;
  collected: number;
  inventoryKnown: boolean;
  sourcesFound: number;
  sourcesBroken: number;
  accessFailed: number;
  durationMs: number;
}

/** Physical methods are awaited under the caller's Executor, never a nested queue. */
export interface CollectionOperations {
  position(): Position;
  dimension(): string;
  inventory(resource: Resource, signal: AbortSignal): Promise<TaskResult<CollectionStock>>;
  search(resource: Resource, origin: Position, exclude: ReadonlySet<string>, signal: AbortSignal): Promise<CollectionSource[]>;
  drops(resource: Resource, origin: Position): CollectionDrop[];
  inspect(source: CollectionSource, resource: Resource): TaskResult<{ canDig: boolean }>;
  move(position: Position, kind: "source" | "drop", signal: AbortSignal): Promise<TaskResult>;
  equip(source: CollectionSource, resource: Resource, signal: AbortSignal): Promise<TaskResult>;
  dig(source: CollectionSource, resource: Resource, signal: AbortSignal): Promise<TaskResult>;
  waitForLoot(resource: Resource, origin: Position, count: number, previous: readonly CollectionDrop[], signal: AbortSignal): Promise<void>;
  waitForPickup(resource: Resource, count: number, signal: AbortSignal): Promise<void>;
}

export interface CollectionOptions {
  signal: AbortSignal;
  progress?: (progress: CollectionProgress) => void;
  trace?: (event: Record<string, unknown>) => void;
}
