import type { ExecutionContext } from "../capabilities/Capability";
import { DigCapability } from "../capabilities/Dig";
import { GotoCapability } from "../capabilities/Goto";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { fromVec3, toVec3 } from "../runtime/PositionAdapter";
import { hasEmptyCraftingArea, ServerInventoryConfirmation } from "../runtime/ServerInventoryConfirmation";
import { waitForConfirmation } from "../runtime/waitForConfirmation";
import type { Position } from "../shared/types";
import { findBlocksCooperatively } from "../world/BlockSearch";
import { COLLECTION_LIMITS } from "./CollectionConfig";
import type { CollectionDrop, CollectionOperations, CollectionSource, CollectionStock } from "./CollectionTypes";
import { canHarvestResource, inspectHarvest } from "./ResourceAccess";
import { pickupPosition } from "./ResourcePickup";
import type { Resource } from "./ResourceCatalog";

export class MineflayerCollectionOperations implements CollectionOperations {
  private readonly goto = new GotoCapability();
  private readonly digging = new DigCapability();
  constructor(private readonly context: ExecutionContext, private readonly observation: ServerInventoryConfirmation) {}
  private get bot() { return this.context.runtime.bot; }
  position(): Position { return fromVec3(this.bot.entity.position); }
  dimension(): string { return this.bot.game.dimension; }

  async inventory(resource: Resource, signal: AbortSignal): Promise<TaskResult<CollectionStock>> {
    if (!await this.observation.synchronize(signal)) return failure("ACTION_NOT_CONFIRMED", "Server inventory snapshot unavailable.");
    const state = this.observation.snapshot;
    if (!state || !hasEmptyCraftingArea(state)) return failure("BLOCKED", "Empty the crafting grid and cursor before collecting.");
    return success({ count: state.items[resource.item] ?? 0,
      capacity: this.observation.capacity(resource.item, this.bot.registry.itemsByName[resource.item]!.stackSize) ?? 0 });
  }

  async search(resource: Resource, origin: Position, exclude: ReadonlySet<string>, signal: AbortSignal): Promise<CollectionSource[]> {
    const ids = new Set(resource.sources.map(name => this.bot.registry.blocksByName[name]!.id));
    const found = await findBlocksCooperatively(this.bot, ids, { origin, exclude, signal,
      maxDistance: COLLECTION_LIMITS.radius, count: COLLECTION_LIMITS.searchBatch });
    return found.map(b => ({ name: b.name, stateId: b.stateId, position: fromVec3(b.position) }));
  }

  drops(resource: Resource, origin: Position): CollectionDrop[] {
    return this.context.world.getNearbyEntities({ maxDistance: COLLECTION_LIMITS.maxRadius * 2 })
      .filter(e => e.droppedItem?.name === resource.item && toVec3(e.position).distanceTo(toVec3(origin)) <= COLLECTION_LIMITS.radius)
      .map(e => ({ id: e.id, count: e.droppedItem!.count, position: { ...e.position } }));
  }

  inspect(source: CollectionSource, resource: Resource): TaskResult<{ canDig: boolean }> {
    const inspected = inspectHarvest(this.bot, source, resource);
    return inspected.ok ? success({ canDig: this.context.world.getBlockAccess(source.position).canDig }) : inspected;
  }

  async move(position: Position, kind: "source" | "drop", signal: AbortSignal): Promise<TaskResult> {
    const target = kind === "drop" ? pickupPosition(this.bot, position) : position;
    if (!target) return failure("BLOCKED", "No nearby loaded landing surface for this loose item.");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("Collection movement timed out.")), COLLECTION_LIMITS.moveTimeoutMs);
    const childSignal = AbortSignal.any([signal, timeout.signal]);
    try {
      return await this.goto.execute({ position: target, goal: kind === "source" ? "interact" : "near", range: kind === "source" ? 4 : 0,
        canDig: false, canPlace: false }, { ...this.context, signal: childSignal });
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.signal.aborted) return failure("TIMEOUT", "Collection movement timed out.");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async equip(source: CollectionSource, resource: Resource, signal: AbortSignal): Promise<TaskResult> {
    signal.throwIfAborted();
    const selected = inspectHarvest(this.bot, source, resource);
    if (!selected.ok) return selected;
    const { tool } = selected.value;
    // Equip the exact stack: same-name tools may have different enchantments or durability.
    if (tool?.slot !== this.bot.heldItem?.slot || (!tool && this.bot.heldItem)) {
      const operation = tool ? this.bot.equip(tool, "hand") : this.bot.unequip("hand");
      this.context.deferCancellationUntil(operation); await operation;
    }
    signal.throwIfAborted();
    return canHarvestResource(selected.value.block, this.bot.heldItem, resource)
      ? success({ tool: this.bot.heldItem?.name ?? "hand" }) : failure("MISSING_ITEM", "The equipped tool cannot produce the requested resource.");
  }

  async dig(source: CollectionSource, resource: Resource, signal: AbortSignal): Promise<TaskResult> {
    signal.throwIfAborted();
    const inspected = inspectHarvest(this.bot, source, resource);
    if (!inspected.ok) return inspected;
    if (!canHarvestResource(inspected.value.block, this.bot.heldItem, resource)) return failure("MISSING_ITEM", "The harvest tool changed before digging.");
    if (!this.context.world.getBlockAccess(source.position).canDig) return failure("OUT_OF_REACH", "The resource no longer has an accessible dig face.");
    return this.digging.execute({ position: source.position }, { ...this.context, signal });
  }

  async waitForLoot(resource: Resource, origin: Position, count: number, previous: readonly CollectionDrop[], signal: AbortSignal): Promise<void> {
    const known = new Map(previous.map(d => [d.id, d.count]));
    await waitForConfirmation(() => (this.observation.snapshot?.items[resource.item] ?? count) > count ||
      this.drops(resource, origin).some(d => d.count > (known.get(d.id) ?? 0)), signal);
  }

  async waitForPickup(resource: Resource, count: number, signal: AbortSignal): Promise<void> {
    await waitForConfirmation(() => (this.observation.snapshot?.items[resource.item] ?? count) > count, signal);
  }
}
