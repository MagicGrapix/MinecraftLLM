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
import { CollectionTerrain } from "./CollectionTerrain";
import { CollectionTrace } from "./CollectionTrace";

export class MineflayerCollectionOperations implements CollectionOperations {
  private readonly goto = new GotoCapability();
  private readonly digging = new DigCapability();
  private terrain?: CollectionTerrain;
  private trace = new CollectionTrace();
  private objective?: { resource: Resource; quantity: number; baseline?: number };
  private reserveAttempts = 0;
  private readonly reserveExcluded = new Set<string>();
  constructor(private readonly context: ExecutionContext, private readonly observation: ServerInventoryConfirmation) {}
  private get bot() { return this.context.runtime.bot; }
  position(): Position { return fromVec3(this.bot.entity.position); }
  dimension(): string { return this.bot.game.dimension; }
  start(resource: Resource, quantity: number, origin: Position, trace: CollectionTrace, changed: () => void): void {
    this.trace = trace; this.objective = { resource, quantity };
    this.terrain = new CollectionTerrain(this.context, this.observation, origin, trace, changed);
  }
  scaffoldsLeft(): number { return this.terrain?.left ?? 0; }
  cleanup(signal: AbortSignal): Promise<TaskResult> { return this.terrain?.cleanup(signal) ?? Promise.resolve(success({})); }
  dispose(): void { this.terrain?.dispose(); }

  async inventory(resource: Resource, signal: AbortSignal): Promise<TaskResult<CollectionStock>> {
    if (!await this.observation.synchronize(signal)) return failure("ACTION_NOT_CONFIRMED", "Server inventory snapshot unavailable.");
    const state = this.observation.snapshot;
    if (!state || !hasEmptyCraftingArea(state)) return failure("BLOCKED", "Empty the crafting grid and cursor before collecting.");
    if (this.objective?.resource.item === resource.item) this.objective.baseline ??= state.items[resource.item] ?? 0;
    return success({ count: state.items[resource.item] ?? 0,
      capacity: this.observation.capacity(resource.item, this.bot.registry.itemsByName[resource.item]!.stackSize) ?? 0 });
  }

  async search(resource: Resource, origin: Position, exclude: ReadonlySet<string>, signal: AbortSignal): Promise<CollectionSource[]> {
    const ids = new Set(resource.sources.map(name => this.bot.registry.blocksByName[name]!.id));
    const found = await findBlocksCooperatively(this.bot, ids, { origin, exclude, signal,
      maxDistance: COLLECTION_LIMITS.radius, count: COLLECTION_LIMITS.searchBatch, allow: b => !this.terrain?.protected(b.position) });
    return found.filter(b => !this.terrain?.protected(b.position)).map(b => ({ name: b.name, stateId: b.stateId, position: fromVec3(b.position) }));
  }

  drops(resource: Resource, origin: Position): CollectionDrop[] {
    return this.context.world.getNearbyEntities({ maxDistance: COLLECTION_LIMITS.maxRadius * 2 })
      .filter(e => e.droppedItem?.name === resource.item && toVec3(e.position).distanceTo(toVec3(origin)) <= COLLECTION_LIMITS.radius)
      .map(e => ({ id: e.id, count: e.droppedItem!.count, position: { ...e.position } }));
  }

  inspect(source: CollectionSource, resource: Resource): TaskResult<{ canDig: boolean }> {
    if (this.terrain?.protected(source.position)) return failure("BLOCKED", "The resource is in a known protected site or temporary access structure.");
    const inspected = inspectHarvest(this.bot, source, resource);
    return inspected.ok ? success({ canDig: this.context.world.getBlockAccess(source.position).canDig }) : inspected;
  }

  async move(position: Position, kind: "source" | "drop", signal: AbortSignal): Promise<TaskResult> {
    const target = kind === "drop" ? pickupPosition(this.bot, position) : position;
    if (!target) return failure("BLOCKED", "No nearby loaded landing surface for this loose item.");
    const item = this.objective?.resource.item;
    const before = item ? this.observation.snapshot?.items[item] ?? 0 : 0;
    const direct = await this.navigate(target, kind, signal, false);
    if (direct.ok || !this.terrain) return direct;
    signal.throwIfAborted();
    // A drop may have been picked up before pathfinder settled at its exact landing cell.
    // Re-observe in the collector instead of digging terrain for an already collected item.
    if (kind === "drop" && item && (this.observation.snapshot?.items[item] ?? 0) > before) return success({ inventoryChangedDuringMove: true });
    // First try obstacle clearing without spending dirt or acquiring an unnecessary reserve.
    const cleared = await this.navigate(target, kind, signal, true, false);
    if (cleared.ok) return cleared;
    const reserve = await this.acquireDirt(position, signal);
    if (!reserve.ok) return reserve;
    if (this.objectiveReached()) return success({ objectiveReachedDuringReserve: true });
    if (kind === "source" && position.y - this.position().y > 4) return this.climbToward(position, signal);
    return this.navigate(target, kind, signal, true, true);
  }

  private async climbToward(target: Position, signal: AbortSignal): Promise<TaskResult> {
    // Pathfinder cannot always plan several still-nonexistent stair supports in one search.
    // Materialize one supported step at a time, then replan against the confirmed world.
    for (let height = 0; height < COLLECTION_LIMITS.maxAccessHeight; height++) {
      signal.throwIfAborted();
      if (this.context.world.getBlockAccess(target).canDig) return success({ access: "stepped" });
      const feet = this.bot.entity.position.floored();
      const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => feet.offset(x!, 1, z!))
        .filter(p => this.terrain!.canPlace(p.offset(0, -1, 0)) && [p, p.offset(0, 1, 0)].every(at => this.bot.blockAt(at)?.name === "air"))
        .sort((a, b) => a.distanceTo(toVec3(target)) - b.distanceTo(toVec3(target)));
      let climbed = false;
      for (const candidate of candidates) {
        const result = await this.navigate(candidate, "drop", signal, true, true, target);
        if (result.ok) { climbed = true; break; }
      }
      if (!climbed) return failure("BLOCKED", "No safe supported step could be built toward this elevated resource.");
    }
    return this.context.world.getBlockAccess(target).canDig ? success({ access: "stepped" })
      : failure("OUT_OF_REACH", "The resource remains out of reach after the bounded stair approach.");
  }

  private objectiveReached(): boolean {
    return !!this.objective && this.objective.baseline !== undefined &&
      (this.observation.snapshot?.items[this.objective.resource.item] ?? 0) - this.objective.baseline >= this.objective.quantity;
  }
  private get reservedDirt(): number {
    return this.objective?.resource.item === "dirt" ? (this.objective.baseline ?? 0) + this.objective.quantity : 0;
  }
  private async navigate(target: Position, kind: "source" | "drop", signal: AbortSignal, modify: boolean, place = false, protectedTarget = target): Promise<TaskResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("Collection movement timed out.")), COLLECTION_LIMITS.moveTimeoutMs);
    const rejected = new AbortController();
    const childSignal = AbortSignal.any([signal, timeout.signal, rejected.signal]);
    const anchor = this.position();
    const policy = modify ? this.terrain!.policy(protectedTarget, anchor, this.reservedDirt, childSignal, message => {
      const error = new Error(message); rejected.abort(error); throw error;
    }) : this.terrain ? { configure: (m: import("mineflayer-pathfinder").Movements) => this.terrain!.configureWalking(m, anchor) } : undefined;
    if (modify && !place) {
      const configure = policy!.configure;
      policy!.configure = m => { configure(m); m.scafoldingBlocks = []; m.allow1by1towers = false; };
    }
    try {
      return await this.trace.run(modify ? "access_modified" : "access_direct", { position: target, canDig: modify, canPlace: place }, () =>
        (policy ? new GotoCapability(policy) : this.goto).execute({ position: target, goal: kind === "source" ? "interact" : "near", range: kind === "source" ? 4 : 0,
          canDig: modify, canPlace: place }, { ...this.context, signal: childSignal }));
    } catch (error) {
      signal.throwIfAborted();
      if (rejected.signal.aborted) return failure("BLOCKED", String(rejected.signal.reason));
      if (timeout.signal.aborted) return failure("TIMEOUT", "Collection movement timed out.");
      throw error;
    } finally { clearTimeout(timer); }
  }

  private async acquireDirt(protectedTarget: Position, signal: AbortSignal): Promise<TaskResult> {
    const dirt: Resource = { item: "dirt", sources: ["dirt", "grass_block"] };
    return this.trace.run("acquire_dirt_reserve", { desired: COLLECTION_LIMITS.dirtReserve, reserved: this.reservedDirt }, async () => {
      const stock = await this.inventory(dirt, signal); if (!stock.ok) return stock;
      while ((this.observation.snapshot?.items.dirt ?? 0) < this.reservedDirt + COLLECTION_LIMITS.dirtReserve && this.reserveAttempts < COLLECTION_LIMITS.reserveAttempts) {
        signal.throwIfAborted();
        if (this.objectiveReached()) return success({ objectiveReached: true });
        const blocks = await findBlocksCooperatively(this.bot, new Set(dirt.sources.map(n => this.bot.registry.blocksByName[n]!.id)), {
          origin: this.position(), maxDistance: COLLECTION_LIMITS.reserveRadius, count: 32, exclude: this.reserveExcluded, signal,
          allow: b => !this.terrain!.protected(b.position) && this.terrain!.within(b.position) });
        const source = blocks.find(b => !b.position.equals(toVec3(protectedTarget)) && this.terrain!.within(b.position) && !this.terrain!.protected(b.position) &&
          inspectHarvest(this.bot, { name: b.name, stateId: b.stateId, position: b.position }, dirt).ok && this.context.world.getBlockAccess(b.position).canDig);
        if (!source) break;
        this.reserveAttempts++; this.reserveExcluded.add(`${source.position.x},${source.position.y},${source.position.z}`);
        const input = { name: source.name, stateId: source.stateId, position: fromVec3(source.position) };
        const before = this.observation.snapshot?.items.dirt ?? 0;
        if ((this.observation.capacity("dirt", 64) ?? 0) < 1) break;
        const equipped = await this.trace.run("reserve_equip", { position: input.position }, () => this.equip(input, dirt, signal));
        if (!equipped.ok) return equipped;
        const drops = this.drops(dirt, this.position());
        const dug = await this.trace.run("reserve_dig", { position: input.position, block: input.name }, () => this.dig(input, dirt, signal));
        if (!dug.ok) continue;
        await this.waitForLoot(dirt, this.position(), before, drops, signal);
        for (const drop of this.drops(dirt, this.position()).slice(0, 4)) {
          const target = pickupPosition(this.bot, drop.position); if (!target) continue;
          await this.navigate(target, "drop", signal, false);
          await this.waitForPickup(dirt, before, signal);
          if ((this.observation.snapshot?.items.dirt ?? 0) > before) break;
        }
        const current = await this.inventory(dirt, signal); if (!current.ok) return current;
      }
      const available = this.observation.snapshot?.items.dirt ?? 0;
      return this.objectiveReached() || available > this.reservedDirt ? success({ available, reserved: this.reservedDirt })
        : failure("MISSING_ITEM", "No unreserved dirt could be collected from directly accessible safe ground.");
    });
  }

  async equip(source: CollectionSource, resource: Resource, signal: AbortSignal): Promise<TaskResult> {
    signal.throwIfAborted();
    if (this.terrain?.protected(source.position)) return failure("BLOCKED", "Protected source cannot be harvested.");
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
    if (this.terrain?.protected(source.position)) return failure("BLOCKED", "Protected source cannot be harvested.");
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
