import { failure, success, type TaskError, type TaskErrorCode, type TaskResult } from "../execution/TaskResult";
import { errorMessage } from "../shared/helper";
import { blockPositionKey } from "../world/BlockSearch";
import { QueryExecutionError } from "../world/queries/QueryLimits";
import { COLLECTION_LIMITS } from "./CollectionConfig";
import type { CollectionOperations, CollectionOptions, CollectionProgress, CollectionStock } from "./CollectionTypes";
import type { Resource } from "./ResourceCatalog";

/** Base collection: existing paths only. Terrain changes/scaffolding belong to the next lot. */
export class ResourceCollector {
  constructor(private readonly ops: CollectionOperations) {}

  async collect(resource: Resource, quantity: number, options: CollectionOptions): Promise<TaskResult<CollectionProgress>> {
    const { signal } = options;
    const origin = { ...this.ops.position() }, dimension = this.ops.dimension(), started = performance.now();
    const progress: CollectionProgress = { item: resource.item, requested: quantity, collected: 0, inventoryKnown: false,
      sourcesFound: 0, sourcesBroken: 0, accessFailed: 0, durationMs: 0 };
    const found = new Set<string>(), excluded = new Set<string>(), inaccessible = new Set<string>();
    const sourcesTried = new Map<string, number>(), dropsTried = new Map<number, number>();
    let baseline: number | undefined, stock: CollectionStock = { count: 0, capacity: 0 }, stalled = 0, sequence = 0;
    let inventoryError: TaskError | undefined;
    const publish = () => { progress.durationMs = Math.round(performance.now() - started); options.progress?.({ ...progress }); };
    const fail = (code: TaskErrorCode, message: string, reason: string): TaskResult<CollectionProgress> => {
      publish(); return failure(code, message, { facts: { reason, progress: { ...progress } } });
    };
    const guard = () => {
      signal.throwIfAborted();
      if (this.ops.dimension() !== dimension) throw new Error("World dimension changed during collection.");
      const p = this.ops.position();
      if (Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) > COLLECTION_LIMITS.maxRadius) throw new Error("Bot left the collection area.");
    };
    const operation = async <T>(name: string, args: unknown, run: () => Promise<T>): Promise<T> => {
      guard(); const index = ++sequence, start = performance.now();
      if (["goto_drop", "goto_source", "dig", "equip"].includes(name)) { progress.inventoryKnown = false; publish(); }
      options.trace?.({ event: "operation_started", index, operation: name, args });
      try {
        const result = await run(); guard();
        options.trace?.({ event: "operation_finished", index, operation: name, durationMs: Math.round(performance.now() - start), result });
        return result;
      } catch (error) {
        options.trace?.({ event: "operation_failed", index, operation: name, durationMs: Math.round(performance.now() - start), error: errorMessage(error) });
        throw error;
      }
    };
    const observe = async (): Promise<boolean> => {
      progress.inventoryKnown = false; publish();
      const result = await operation("inventory", { item: resource.item }, () => this.ops.inventory(resource, signal));
      if (!result.ok) { inventoryError = result.error; return false; }
      stock = result.value; baseline ??= stock.count;
      progress.collected = Math.max(0, stock.count - baseline); progress.inventoryKnown = true; publish();
      return true;
    };
    const inventoryFailure = () => fail(inventoryError?.code ?? "ACTION_NOT_CONFIRMED", inventoryError?.message ?? "Server inventory unavailable.", "INVENTORY_UNAVAILABLE");
    const noteFailure = (key: string) => {
      inaccessible.add(key); progress.accessFailed = inaccessible.size;
      const attempts = (sourcesTried.get(key) ?? 0) + 1; sourcesTried.set(key, attempts);
      if (attempts >= COLLECTION_LIMITS.maxSourceAttempts) excluded.add(key);
    };
    options.trace?.({ event: "started", item: resource.item, quantity, origin, dimension });
    try {
      if (!await observe()) return inventoryFailure();
      options.trace?.({ event: "baseline", count: baseline });
      for (let iteration = 0; iteration < COLLECTION_LIMITS.maxIterations; iteration++) {
        guard();
        if (progress.collected >= quantity) return success({ ...progress });
        if (stock.capacity < 1) return fail("BLOCKED", "No inventory space remains for this resource.", "INVENTORY_FULL");
        if (stalled >= COLLECTION_LIMITS.maxStalledAttempts) return fail("BLOCKED", "Collection stopped after repeated attempts without inventory gain.", "NO_PROGRESS");
        const previousGain = progress.collected;
        const drop = this.ops.drops(resource, origin).find(d => (dropsTried.get(d.id) ?? 0) < COLLECTION_LIMITS.maxDropAttempts);
        if (drop) {
          dropsTried.set(drop.id, (dropsTried.get(drop.id) ?? 0) + 1);
          // Re-read moving entities immediately before navigation; disappearance is never pickup proof.
          const current = this.ops.drops(resource, origin).find(d => d.id === drop.id);
          if (current) await operation("goto_drop", { id: current.id, position: current.position }, () => this.ops.move(current.position, "drop", signal));
          await operation("wait_pickup", { id: drop.id }, () => this.ops.waitForPickup(resource, stock.count, signal));
        } else {
          const sources = await operation("search", { origin, radius: COLLECTION_LIMITS.radius }, () => this.ops.search(resource, origin, excluded, signal));
          for (const source of sources) found.add(blockPositionKey(source.position));
          progress.sourcesFound = found.size; publish();
          // Prefer a new candidate to immediately repeating the same failed route.
          sources.sort((a, b) => (sourcesTried.get(blockPositionKey(a.position)) ?? 0) - (sourcesTried.get(blockPositionKey(b.position)) ?? 0));
          const source = sources[0];
          if (!source) return fail(found.size ? "BLOCKED" : "TARGET_NOT_FOUND", "No remaining usable source or reachable loose item was found in the loaded search area.", "SOURCES_EXHAUSTED");
          const key = blockPositionKey(source.position);
          let access = this.ops.inspect(source, resource);
          options.trace?.({ event: "source_inspected", position: source.position, result: access });
          if (!access.ok && access.error.code === "MISSING_ITEM") return fail("MISSING_ITEM", access.error.message, "HARVEST_TOOL_MISSING");
          if (access.ok && !access.value.canDig) {
            const moved = await operation("goto_source", { position: source.position }, () => this.ops.move(source.position, "source", signal));
            if (!await observe()) return inventoryFailure();
            if (progress.collected >= quantity) continue;
            access = moved.ok ? this.ops.inspect(source, resource) : moved as TaskResult<{ canDig: boolean }>;
          }
          if (!access.ok || !access.value.canDig) {
            noteFailure(key);
          } else {
            const equipped = await operation("equip", { position: source.position }, () => this.ops.equip(source, resource, signal));
            if (!equipped.ok) return fail(equipped.error.code, equipped.error.message, "HARVEST_PRECONDITION");
            // Recheck net gain and space before extraction, not just at the start of the loop.
            if (!await observe()) return inventoryFailure();
            if (progress.collected >= quantity) continue;
            if (stock.capacity < 1) return fail("BLOCKED", "No inventory space remains for this resource.", "INVENTORY_FULL");
            const previousDrops = this.ops.drops(resource, origin);
            const dug = await operation("dig", { position: source.position, block: source.name }, () => this.ops.dig(source, resource, signal));
            excluded.add(key); // Never blindly repeat an unconfirmed physical dig at this cell.
            if (dug.ok) progress.sourcesBroken++;
            publish();
            await operation("wait_loot", { position: source.position }, () => this.ops.waitForLoot(resource, origin, stock.count, previousDrops, signal));
            if (!dug.ok && dug.error.code === "MISSING_ITEM") return fail("MISSING_ITEM", dug.error.message, "HARVEST_TOOL_MISSING");
          }
        }
        if (!await observe()) return inventoryFailure();
        stalled = progress.collected > previousGain ? 0 : stalled + 1;
      }
      return fail("BLOCKED", "Collection attempt budget exhausted.", "ATTEMPT_LIMIT");
    } catch (error) {
      progress.inventoryKnown = false; publish();
      if (signal.aborted) throw error;
      return fail(error instanceof QueryExecutionError ? "TIMEOUT" : "WORLD_CHANGED", errorMessage(error), "OBSERVATION_FAILED");
    } finally {
      publish(); options.trace?.({ event: "finished", progress: { ...progress } });
    }
  }
}
