import { failure, success, type TaskResult } from "../../src/execution/TaskResult";
import type { Position } from "../../src/shared/types";
import { blockPositionKey } from "../../src/world/BlockSearch";
import type { CollectionDrop, CollectionOperations, CollectionSource, CollectionStock } from "../../src/collection/CollectionTypes";
import type { Resource } from "../../src/collection/ResourceCatalog";

export const oakResource: Resource = { item: "oak_log", sources: ["oak_log"] };
export class TestCollectionOperations implements CollectionOperations {
  feet: Position = { x: 0, y: 0, z: 0 };
  world = "overworld";
  count = 1; capacity = 64;
  sources: CollectionSource[] = Array.from({ length: 4 }, (_, x) => ({ name: "oak_log", stateId: 1, position: { x: x + 3, y: 0, z: 0 } }));
  loose: CollectionDrop[] = [];
  dug: CollectionSource[] = [];
  moves: { position: Position; kind: string }[] = [];
  searchOrigins: Position[] = [];
  waits = 0;
  accessible = true;
  onInventory?: () => void;
  onInspect?: (s: CollectionSource) => TaskResult<{ canDig: boolean }>;
  onMove?: (p: Position, kind: string, signal: AbortSignal) => Promise<TaskResult>;
  onDig?: (s: CollectionSource, signal: AbortSignal) => Promise<TaskResult>;
  onEquip?: () => TaskResult;
  onLoot?: () => Promise<void>;
  onPickup?: (signal: AbortSignal) => Promise<void>;
  inventoryAvailable = true;
  position() { return { ...this.feet }; }
  dimension() { return this.world; }
  async inventory(): Promise<TaskResult<CollectionStock>> {
    this.onInventory?.();
    return this.inventoryAvailable ? success({ count: this.count, capacity: this.capacity }) : failure("ACTION_NOT_CONFIRMED", "Inventory unknown");
  }
  async search(_r: Resource, origin: Position, exclude: ReadonlySet<string>): Promise<CollectionSource[]> {
    this.searchOrigins.push({ ...origin });
    return this.sources.filter(s => !exclude.has(blockPositionKey(s.position)));
  }
  drops() { return this.loose.map(d => ({ ...d, position: { ...d.position } })); }
  inspect(s: CollectionSource): TaskResult<{ canDig: boolean }> { return this.onInspect?.(s) ?? success({ canDig: this.accessible }); }
  async move(p: Position, kind: "source" | "drop", signal: AbortSignal): Promise<TaskResult> {
    this.moves.push({ position: { ...p }, kind });
    if (this.onMove) return this.onMove(p, kind, signal);
    this.feet = { ...p };
    if (kind === "drop") {
      const drop = this.loose.find(d => blockPositionKey(d.position) === blockPositionKey(p));
      if (drop) { this.count += drop.count; this.loose = this.loose.filter(d => d !== drop); }
    } else this.accessible = true;
    return success({});
  }
  async equip(): Promise<TaskResult> { return this.onEquip?.() ?? success({}); }
  async dig(s: CollectionSource, _r: Resource, signal: AbortSignal): Promise<TaskResult> {
    this.dug.push(s);
    if (this.onDig) return this.onDig(s, signal);
    this.sources = this.sources.filter(b => b !== s);
    this.loose.push({ id: this.dug.length, position: { ...s.position }, count: 1 });
    return success({});
  }
  async waitForLoot(): Promise<void> { this.waits++; await this.onLoot?.(); }
  async waitForPickup(_r: Resource, _count: number, signal: AbortSignal): Promise<void> { await this.onPickup?.(signal); }
}
