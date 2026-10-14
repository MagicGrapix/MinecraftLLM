import { Vec3 } from "vec3";
import { success, type TaskErrorCode, type TaskResult } from "../execution/TaskResult";
import type { Position } from "../shared/types";
import type { BlueprintPlacement, CompiledBlueprint } from "./Blueprint";
import type { BuildEvent, BuildInput, BuildOperations, BuildProgress, ScaffoldState } from "./BuildTypes";
import { BUILD_LIMITS } from "./BuildingConfig";
import { canPlaceFrom, placementCandidates, workPositions, type PlacementCandidate } from "./BuildPlacement";
import { checkBuildMaterials, checkBuildSite, inspectBuild } from "./BuildVerification";
import { safeExitStances } from "./BuildExit";
import { canPlaceDoor, doorCandidates } from "./BuildDoor";
import { BuildScaffolding, recoverableBuildMove } from "./BuildScaffolding";

export interface BuilderOptions {
  readonly signal: AbortSignal;
  readonly progress?: (progress: BuildProgress) => void;
  readonly trace?: (event: BuildEvent) => void;
}

/** Deterministic, bounded builder. Geometry is a proposal; fresh observations decide success. */
export class Builder {
  constructor(private readonly ops: BuildOperations, private readonly scaffolds: ScaffoldState = []) {}

  async build(plan: CompiledBlueprint, input: BuildInput, options: BuilderOptions): Promise<TaskResult<BuildProgress>> {
    const { signal } = options;
    const startedAt = Date.now();
    const progress: BuildProgress = { ...input, origin: { ...input.origin }, phase: "preflight", dimension: this.ops.dimension, durationMs: 0,
      total: plan.operations.length, correct: 0, alreadyCorrect: 0, placedThisCall: 0, remaining: plan.operations.length,
      scaffolding: { item: "dirt", placedThisCall: 0, removedThisCall: 0, remaining: [], uncertain: [] } };
    const publish = () => {
      progress.durationMs = Date.now() - startedAt;
      progress.scaffolding.remaining = this.scaffolds.map(b => ({ ...b.position }));
      progress.scaffolding.uncertain = this.scaffolds.filter(b => b.stateId === null).map(b => ({ ...b.position }));
      options.progress?.(structuredClone(progress));
    };
    const scaffolding = new BuildScaffolding(this.ops, plan, input.origin, this.scaffolds, {
      signal, changed: publish, placed: () => progress.scaffolding.placedThisCall++,
      removed: () => progress.scaffolding.removedThisCall++, trace: options.trace,
    });
    const fail = (result: Extract<TaskResult, { ok: false }>): TaskResult<BuildProgress> => {
      publish(); options.trace?.({ event: "finished", code: result.error.code, error: structuredClone(result.error), progress: structuredClone(progress) });
      return { ok: false, error: { ...result.error, facts: { ...result.error.facts, progress: structuredClone(progress) } } };
    };
    const reject = (code: TaskErrorCode, message: string, facts?: Record<string, unknown>) =>
      fail({ ok: false, error: { code, message, retryable: false, ...(facts ? { facts } : {}) } });
    try {
      signal.throwIfAborted();
      publish(); options.trace?.({ event: "started" });
      const site = checkBuildSite(plan, input.origin, this.ops);
      if (!site.ok) return fail(site);
      const tracked = scaffolding.reconcile();
      if (!tracked.ok) return fail(tracked);
      let inspected = inspectBuild(plan, input.origin, this.ops);
      if (!inspected.ok) return fail(inspected);
      progress.correct = progress.alreadyCorrect = inspected.value.correct; progress.remaining = inspected.value.pending.length; publish();
      const materials = checkBuildMaterials(inspected.value.pending, this.ops);
      if (!materials.ok) return fail(materials);

      progress.phase = "building";
      // Each iteration confirms a permanent block or adds bounded temporary access.
      for (let iteration = 0; inspected.value.pending.length && iteration < plan.operations.length + BUILD_LIMITS.maxScaffoldBlocks; iteration++) {
        signal.throwIfAborted(); publish();
        if (this.ops.dimension !== progress.dimension) return fail({ ok: false, error: { code: "WORLD_CHANGED", message: "The bot changed dimension during construction.", retryable: false } });
        const positions = workPositions(plan, input.origin, this.ops);
        // A floating cell may become supported by a neighbouring cell placed later in drawing order.
        let choice: { op: BlueprintPlacement; candidates: PlacementCandidate[] } | undefined;
        const cubesRemain = inspected.value.pending.some(op => op.kind === "place_block");
        for (const op of inspected.value.pending) {
          const door = op.kind === "place_door";
          if (door && cubesRemain) continue; // Hinge selection depends on the finished walls.
          const safe = safeExitStances(plan, input.origin, this.ops, op.position, door);
          const candidates = door ? doorCandidates(op, positions, this.ops, safe) : placementCandidates(op.position, positions, this.ops, safe);
          if (candidates.length) { choice = { op, candidates }; break; }
        }
        if (!choice) {
          const access = await scaffolding.addAccess(inspected.value.pending);
          if (!access.ok) return fail(access);
          continue;
        }
        let placed = false;
        const attempts: { position: Position; code: string }[] = [];
        for (const candidate of choice.candidates) {
          signal.throwIfAborted();
          if (this.ops.dimension !== progress.dimension) return reject("WORLD_CHANGED", "The bot changed dimension during construction.");
          const { op } = choice;
          if (this.ops.position().distanceTo(new Vec3(candidate.feet.x, candidate.feet.y, candidate.feet.z)) > 0.05) {
            const feet = { x: Math.floor(candidate.feet.x), y: Math.floor(candidate.feet.y), z: Math.floor(candidate.feet.z) };
            options.trace?.({ event: "move_started", position: feet });
            const moved = await this.ops.move(feet);
            options.trace?.({ event: "move_finished", position: feet, ...(moved.ok ? {} : { code: moved.error.code }) });
            signal.throwIfAborted();
            if (!moved.ok) {
              attempts.push({ position: feet, code: moved.error.code });
              if (!recoverableBuildMove(moved)) return fail(moved);
              continue;
            }
          }
          // Never place based only on the candidate's hypothetical eyes or old inventory/world.
          if (this.ops.dimension !== progress.dimension) return fail({ ok: false, error: { code: "WORLD_CHANGED", message: "The bot changed dimension during construction.", retryable: false } });
          inspected = inspectBuild(plan, input.origin, this.ops);
          if (!inspected.ok) return fail(inspected);
          const currentMaterials = checkBuildMaterials(inspected.value.pending, this.ops);
          if (!currentMaterials.ok) return fail(currentMaterials);
          const eyes = this.ops.eyes();
          const door = op.kind === "place_door";
          if (!eyes || !(door ? canPlaceDoor(this.ops, op, eyes, this.ops.position()) : canPlaceFrom(this.ops, candidate, eyes, this.ops.position())) ||
            !safeExitStances(plan, input.origin, this.ops, op.position, door)(this.ops.position())) continue;
          options.trace?.({ event: "place_started", position: op.position, block: op.block });
          const result = door ? await this.ops.placeDoor(op) : await this.ops.place(candidate, op.block);
          signal.throwIfAborted();
          if (this.ops.dimension !== progress.dimension) return reject("WORLD_CHANGED", "The bot changed dimension during construction.");
          if (!result.ok) return fail(result); // No blind retry after an uncertain server response.
          if (this.ops.blockAt(op.position)?.name !== op.block) return reject("WORLD_CHANGED", "The placed block changed before verification.",
            { position: op.position, expected: op.block });
          progress.placedThisCall++;
          options.trace?.({ event: "place_confirmed", position: op.position, block: op.block });
          placed = true; break;
        }
        if (!placed) {
          if ((this.ops.inventory().get("dirt") ?? 0) > inspected.value.pending.filter(op => op.item === "dirt").length) {
            const access = await scaffolding.addAccess(inspected.value.pending);
            if (!access.ok) return fail(access);
            continue;
          }
          return reject("NO_PATH", "No tested work position allowed this placement.",
            { reason: "NO_WORK_POSITION", position: choice.op.position, attempts });
        }
        inspected = inspectBuild(plan, input.origin, this.ops);
        if (!inspected.ok) return fail(inspected);
        progress.correct = inspected.value.correct; progress.remaining = inspected.value.pending.length; publish();
      }

      // Do not declare success while sealed inside/on top of the structure.
      progress.phase = "exit"; publish();
      const outside = (p: Position) => p.x < input.origin.x || p.x >= input.origin.x + plan.blueprint.width ||
        p.z < input.origin.z || p.z >= input.origin.z + plan.blueprint.depth;
      let exited = outside(this.ops.position()) && Math.abs(this.ops.position().y - input.origin.y) < 0.01;
      if (!exited) {
        const exits = workPositions(plan, input.origin, this.ops).filter((p) => p.y === input.origin.y && outside(p)).slice(0, BUILD_LIMITS.maxCandidates);
        for (const exit of exits) {
          signal.throwIfAborted();
          if (this.ops.dimension !== progress.dimension) return reject("WORLD_CHANGED", "The bot changed dimension during construction.");
          options.trace?.({ event: "move_started", position: exit });
          const moved = await this.ops.move(exit);
          options.trace?.({ event: "move_finished", position: exit, ...(moved.ok ? {} : { code: moved.error.code }) });
          signal.throwIfAborted();
          if (this.ops.dimension !== progress.dimension) return reject("WORLD_CHANGED", "The bot changed dimension during construction.");
          exited = moved.ok && outside(this.ops.position()) && Math.abs(this.ops.position().y - input.origin.y) < 0.01;
          if (exited) break;
          if (!moved.ok && !recoverableBuildMove(moved)) return fail(moved);
        }
      }
      if (!exited) return reject("NO_PATH", "Construction may be complete, but the bot could not leave the footprint safely.", { reason: "EXIT_BLOCKED" });
      progress.phase = "cleanup"; publish();
      const cleaned = await scaffolding.cleanup();
      if (!cleaned.ok) return fail({ ok: false, error: { ...cleaned.error,
        message: `Construction cleanup is incomplete: ${cleaned.error.message}`,
        facts: { reason: "SCAFFOLD_CLEANUP_INCOMPLETE", cause: cleaned.error },
      } });
      progress.phase = "verifying"; publish(); signal.throwIfAborted();
      if (this.ops.dimension !== progress.dimension) return fail({ ok: false, error: { code: "WORLD_CHANGED", message: "The bot changed dimension during construction.", retryable: false } });
      inspected = inspectBuild(plan, input.origin, this.ops);
      if (!inspected.ok) return fail(inspected);
      progress.correct = inspected.value.correct; progress.remaining = inspected.value.pending.length;
      if (progress.remaining) return reject("WORLD_CHANGED", "The final observation found missing blueprint blocks.");
      progress.phase = "complete"; publish(); options.trace?.({ event: "finished", progress: structuredClone(progress) });
      return success(structuredClone(progress));
    } finally { publish(); }
  }
}
