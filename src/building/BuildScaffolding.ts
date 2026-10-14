import { iterators } from "prismarine-world";
import { Vec3 } from "vec3";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import type { Position } from "../shared/types";
import type { BlueprintPlacement, CompiledBlueprint } from "./Blueprint";
import { BUILD_LIMITS } from "./BuildingConfig";
import type { BuildEvent, BuildOperations, ScaffoldState } from "./BuildTypes";
import { safeExitStances } from "./BuildExit";
import { doorCandidates } from "./BuildDoor";
import { canPlaceFrom, overlapsBot, placementCandidates, workPositions } from "./BuildPlacement";
import { isAir, isFullCube } from "./BuildVerification";

const key = (p: Position) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const vec = (p: Position) => new Vec3(p.x, p.y, p.z);
/** A path-search budget is local to one stance, unlike the enclosing action deadline. */
export const recoverableBuildMove = (result: TaskResult) => !result.ok &&
  (["NO_PATH", "OUT_OF_REACH", "BLOCKED"].includes(result.error.code) ||
    (result.error.code === "TIMEOUT" && result.error.facts?.reason === "Timeout"));

interface ScaffoldOptions {
  signal: AbortSignal;
  changed(): void;
  placed(): void;
  removed(): void;
  trace?: (event: BuildEvent) => void;
}

/** shortcut: short exterior dirt stairs only; extend when a real blueprint needs another access shape. */
export class BuildScaffolding {
  private readonly dimension: string;
  constructor(private readonly ops: BuildOperations, private readonly plan: CompiledBlueprint,
    private readonly origin: Position, private readonly state: ScaffoldState, private readonly options: ScaffoldOptions) {
    this.dimension = ops.dimension;
  }

  private guard(): TaskResult {
    this.options.signal.throwIfAborted();
    return this.ops.dimension === this.dimension ? success({})
      : failure("WORLD_CHANGED", "The bot changed dimension during scaffold work.");
  }

  /** A changed block is left intact. Missing blocks need no cleanup and may be rebuilt. */
  reconcile(): TaskResult {
    for (let i = this.state.length - 1; i >= 0; i--) {
      const entry = this.state[i]!, block = this.ops.blockAt(entry.position);
      if (isAir(block)) { this.state.splice(i, 1); continue; }
      if (!block || entry.stateId === null || block.name !== "dirt" || block.stateId !== entry.stateId) {
        return failure("BLOCKED", "Tracked scaffolding is changed, unavailable or unconfirmed; observe it before resuming. No block was removed.", {
          facts: { reason: "SCAFFOLD_OWNERSHIP_UNCERTAIN", position: entry.position, observed: block?.name ?? null },
        });
      }
    }
    return success({});
  }

  async addAccess(pending: readonly BlueprintPlacement[]): Promise<TaskResult> {
    const guarded = this.guard(); if (!guarded.ok) return guarded;
    const tracked = this.reconcile(); if (!tracked.ok) return tracked;
    const owned = new Set(this.state.map(entry => key(entry.position)));
    const layouts = this.layouts().map(cells => ({ cells, added: cells.filter(p => !owned.has(key(p))) }))
      .filter(({ cells, added }) => added.length > 0 && this.state.length + added.length <= BUILD_LIMITS.maxScaffoldBlocks
        && cells.every(p => (owned.has(key(p)) || isAir(this.ops.blockAt(p)))
          && isFullCube(this.ops.blockAt({ ...p, y: this.origin.y - 1 }))))
      .sort((a, b) => a.added.length - b.added.length);
    const cubesRemain = pending.some(op => op.kind === "place_block");
    const layout = layouts.find(({ cells, added }) => {
      const preview = this.preview(cells);
      const positions = workPositions(this.plan, this.origin, preview);
      const newPlatforms = new Set(added.map(p => key({ ...p, y: p.y + 1 })));
      return pending.some(op => {
        const door = op.kind === "place_door";
        if (door && cubesRemain) return false;
        const exit = safeExitStances(this.plan, this.origin, preview, op.position, door);
        const usable = (p: Position) => newPlatforms.has(key(p)) && exit(p);
        return (door ? doorCandidates(op, positions, preview, usable)
          : placementCandidates(op.position, positions, preview, usable)).length > 0;
      });
    });
    if (!layout) return failure("OUT_OF_REACH", "No supported placement or bounded exterior dirt staircase provides access.", {
      facts: { reason: "NO_SCAFFOLD_ACCESS", maxScaffoldBlocks: BUILD_LIMITS.maxScaffoldBlocks },
    });
    const reserved = pending.filter(op => op.item === "dirt").length;
    const stock = this.checkStock(reserved, layout.added.length); if (!stock.ok) return stock;
    this.options.trace?.({ event: "scaffold_planned", positions: layout.added });
    for (let i = 0; i < layout.added.length; i++) {
      const guarded = this.guard(); if (!guarded.ok) return guarded;
      const stock = this.checkStock(reserved, layout.added.length - i); if (!stock.ok) return stock;
      const target = layout.added[i]!;
      const safe = safeExitStances(this.plan, this.origin, this.ops, target);
      const candidates = placementCandidates(target, workPositions(this.plan, this.origin, this.ops), this.ops, safe);
      let placed = false;
      for (const candidate of candidates) {
        const moved = await this.move(candidate.feet);
        if (!moved.ok) { if (recoverableBuildMove(moved)) continue; return moved; }
        const stock = this.checkStock(reserved, layout.added.length - i); if (!stock.ok) return stock;
        const eyes = this.ops.eyes();
        if (!eyes || !canPlaceFrom(this.ops, candidate, eyes, this.ops.position()) ||
          !safeExitStances(this.plan, this.origin, this.ops, target)(this.ops.position())) continue;
        const before = this.ops.blockAt(target)!;
        const entry = { position: { ...target }, previousStateId: before.stateId, stateId: null as number | null };
        this.state.push(entry); // Record BEFORE dispatch: a timeout may still have placed it.
        this.options.changed();
        this.options.trace?.({ event: "scaffold_place_started", position: target, previousStateId: before.stateId, block: "dirt" });
        const result = await this.ops.place(candidate, "dirt");
        const observed = this.ops.blockAt(target);
        if (this.ops.dimension === this.dimension && result.ok && observed?.name === "dirt") {
          entry.stateId = observed.stateId;
          this.options.placed(); this.options.changed();
          this.options.trace?.({ event: "scaffold_place_confirmed", position: target, block: "dirt", stateId: entry.stateId });
        }
        const guarded = this.guard(); if (!guarded.ok) return guarded;
        if (!result.ok) return result;
        if (entry.stateId === null) return failure("ACTION_NOT_CONFIRMED", "Temporary dirt placement was not confirmed.", { facts: { position: target } });
        placed = true; break;
      }
      if (!placed) return failure("NO_PATH", "Could not reach a safe position to place the temporary staircase.", { facts: { position: target } });
    }
    return success({});
  }

  /** Remove from the top down, while standing on exterior ground, never on the removed support. */
  async cleanup(): Promise<TaskResult> {
    const guarded = this.guard(); if (!guarded.ok) return guarded;
    const tracked = this.reconcile(); if (!tracked.ok) return tracked;
    const entries = [...this.state].sort((a, b) => b.position.y - a.position.y);
    for (const entry of entries) {
      const guarded = this.guard(); if (!guarded.ok) return guarded;
      const positions = workPositions(this.plan, this.origin, this.ops).filter(p => p.y === this.origin.y && this.outside(p));
      const candidates = [this.ops.position(), ...positions.map(p => vec(p).offset(0.5, 0, 0.5))]
        .filter(p => this.canRemoveFrom(entry.position, p)).slice(0, BUILD_LIMITS.maxCandidates);
      let removed = false;
      for (const candidate of candidates) {
        const moved = await this.move(candidate);
        if (!moved.ok) { if (recoverableBuildMove(moved)) continue; return moved; }
        const block = this.ops.blockAt(entry.position);
        if (!block || block.name !== "dirt" || block.stateId !== entry.stateId) {
          return failure("WORLD_CHANGED", "Tracked dirt changed before cleanup; it was left intact.", { facts: { position: entry.position } });
        }
        if (!this.canRemoveFrom(entry.position, this.ops.position())) continue;
        this.options.trace?.({ event: "scaffold_remove_started", position: entry.position, block: "dirt" });
        const result = await this.ops.removeScaffold(entry.position, entry.stateId!);
        if (this.ops.dimension === this.dimension && result.ok && isAir(this.ops.blockAt(entry.position))) {
          this.state.splice(this.state.indexOf(entry), 1);
          this.options.removed(); this.options.changed();
          this.options.trace?.({ event: "scaffold_remove_confirmed", position: entry.position, block: "dirt" });
          removed = true;
        }
        const guarded = this.guard(); if (!guarded.ok) return guarded;
        if (!result.ok) return result;
        if (!removed) return failure("ACTION_NOT_CONFIRMED", "Scaffold removal was not confirmed.", { facts: { position: entry.position } });
        break;
      }
      if (!removed) return failure("NO_PATH", "No safe ground position can reach the remaining scaffolding.", { facts: { position: entry.position } });
    }
    return success({});
  }

  private checkStock(reserved: number, temporary: number): TaskResult {
    const available = this.ops.inventory().get("dirt") ?? 0;
    return available >= reserved + temporary ? success({})
      : failure("MISSING_ITEM", "Extra dirt is required for temporary access; construction materials are reserved.", {
        facts: { reason: "MISSING_SCAFFOLD_MATERIALS", item: "dirt", constructionRequired: reserved,
          scaffoldingRequired: temporary, available, missing: reserved + temporary - available },
      });
  }

  private async move(feet: Position): Promise<TaskResult> {
    const guarded = this.guard(); if (!guarded.ok) return guarded;
    if (this.ops.position().distanceTo(vec(feet)) < 0.05) return success({});
    const position = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
    this.options.trace?.({ event: "move_started", position });
    const result = await this.ops.move(position);
    const after = this.guard(); if (!after.ok) return after;
    this.options.trace?.({ event: "move_finished", position, ...(result.ok ? {} : { code: result.error.code }) });
    return result;
  }

  private outside(p: Position): boolean {
    return p.x < this.origin.x || p.x >= this.origin.x + this.plan.blueprint.width
      || p.z < this.origin.z || p.z >= this.origin.z + this.plan.blueprint.depth;
  }

  private canRemoveFrom(target: Position, feet: Position): boolean {
    if (!this.outside(feet) || Math.abs(feet.y - this.origin.y) > 0.01 || overlapsBot(target, feet)) return false;
    const actualEyes = this.ops.eyes(); if (!actualEyes) return false;
    const eyes = vec(feet).offset(0, actualEyes.y - this.ops.position().y, 0);
    const center = vec(target).offset(0.5, 0.5, 0.5), distance = eyes.distanceTo(center);
    if (distance > BUILD_LIMITS.placementReach) return false;
    const ray = new iterators.RaycastIterator(eyes, center.minus(eyes).normalize(), distance);
    let cell: Position | null = eyes.floored();
    while (cell) {
      const block = this.ops.blockAt(cell); if (!block) return false;
      if (ray.intersect(block.shapes, block.position)) return key(cell) === key(target);
      cell = ray.next();
    }
    return false;
  }

  private layouts(): Position[][] {
    const { x, y, z } = this.origin, { width, depth } = this.plan.blueprint, m = BUILD_LIMITS.workMargin;
    const layouts: Position[][] = [];
    for (let height = 1; height <= Math.min(BUILD_LIMITS.maxScaffoldHeight, this.plan.height); height++) {
      for (const side of ["west", "east", "north", "south"] as const) {
        const alongZ = side === "west" || side === "east";
        const min = (alongZ ? z : x) - m, max = (alongZ ? z + depth : x + width) + m - 1;
        for (let start = min; start <= max - height + 1; start++) for (const direction of [1, -1]) {
          const cells: Position[] = [];
          for (let step = 0; step < height; step++) {
            const along = direction === 1 ? start + step : start + height - 1 - step;
            for (let level = 0; level <= step; level++) cells.push({
              x: alongZ ? side === "west" ? x - 1 : x + width : along,
              z: alongZ ? along : side === "north" ? z - 1 : z + depth,
              y: y + level,
            });
          }
          layouts.push(cells);
        }
      }
    }
    return layouts;
  }

  private preview(cells: readonly Position[]): BuildOperations {
    const planned = new Set(cells.map(key)), ops = this.ops;
    const blockAt: BuildOperations["blockAt"] = p => {
      if (!planned.has(key(p))) return ops.blockAt(p);
      const ground = ops.blockAt({ x: p.x, y: this.origin.y - 1, z: p.z })!;
      return { ...ground, name: "dirt", position: vec(p), shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}),
        canHarvest: ground.canHarvest, digTime: ground.digTime };
    };
    return { blockAt, position: () => ops.position(), eyes: () => ops.eyes(), inventory: () => ops.inventory(),
      minY: ops.minY, maxY: ops.maxY, dimension: ops.dimension, move: p => ops.move(p),
      place: (p, b) => ops.place(p, b), placeDoor: d => ops.placeDoor(d), removeScaffold: (p, s) => ops.removeScaffold(p, s) };
  }
}
