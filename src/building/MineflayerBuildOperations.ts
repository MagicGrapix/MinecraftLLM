import type { ExecutionContext } from "../capabilities/Capability";
import { GotoCapability } from "../capabilities/Goto";
import { EquipCapability } from "../capabilities/Equip";
import { DigCapability } from "../capabilities/Dig";
import { PlaceCapability, type PlaceInput } from "../capabilities/Place";
import { failure, type TaskResult } from "../execution/TaskResult";
import { toVec3 } from "../runtime/PositionAdapter";
import { ServerBlockObservation } from "../runtime/ServerBlockObservation";
import type { Position } from "../shared/types";
import { BUILD_LIMITS } from "./BuildingConfig";
import { canPlaceFrom } from "./BuildPlacement";
import type { BuildOperations } from "./BuildTypes";
import type { DoorPlacement } from "./Blueprint";
import { placeBuildDoor } from "./PlaceBuildDoor";

/** No Executor here: all promises and cancellation barriers belong to the outer build. */
export class MineflayerBuildOperations implements BuildOperations {
  private readonly goto = new GotoCapability();
  private readonly equip = new EquipCapability();
  private readonly placement = new PlaceCapability();
  private readonly digging = new DigCapability();
  constructor(private readonly context: ExecutionContext) {}
  private get bot() { return this.context.runtime.bot; }
  // Mineflayer game.js supplies these in Java; upstream GameState typings omit them.
  private get bounds() { return this.bot.game as typeof this.bot.game & { minY: number; height: number }; }
  get minY(): number { return this.bounds.minY; }
  get maxY(): number { return this.bounds.minY + this.bounds.height - 1; }
  get dimension(): string { return this.bot.game.dimension; }
  blockAt(position: Position) { return this.bot.blockAt(toVec3(position)); }
  position() { return this.bot.entity.position.clone(); }
  eyes() {
    const height = (this.bot.entity as typeof this.bot.entity & { eyeHeight?: number }).eyeHeight;
    return height !== undefined && Number.isFinite(height) && this.bot.entity.onGround ? this.position().offset(0, height, 0) : null;
  }
  inventory(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const item of this.bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    return counts;
  }
  async move(position: Position): Promise<TaskResult> {
    return this.goto.execute(this.goto.inputSchema.parse({ position, range: 0, canDig: false, canPlace: false }), this.context);
  }
  async removeScaffold(position: Position, expectedStateId: number): Promise<TaskResult> {
    this.context.signal.throwIfAborted();
    const block = this.blockAt(position);
    if (block?.name !== "dirt" || block.stateId !== expectedStateId) {
      return failure("WORLD_CHANGED", "The tracked scaffold changed; it will not be removed.", { facts: { position } });
    }
    return this.digging.execute({ position }, this.context);
  }
  async placeDoor(door: DoorPlacement): Promise<TaskResult> {
    this.context.signal.throwIfAborted();
    const equipped = await this.equip.execute(this.equip.inputSchema.parse({ item: door.item, destination: "hand" }), this.context);
    this.context.signal.throwIfAborted();
    return equipped.ok ? placeBuildDoor(this.bot, this, door, this.context.signal) : equipped;
  }
  async place(input: PlaceInput, block: string): Promise<TaskResult> {
    const { signal } = this.context;
    signal.throwIfAborted();
    const equipped = await this.equip.execute(this.equip.inputSchema.parse({ item: block, destination: "hand" }), this.context);
    if (!equipped.ok) return equipped;
    const eyes = this.eyes();
    if (this.bot.heldItem?.name !== block || !eyes || !canPlaceFrom(this, input, eyes, this.position())) {
      return failure("WORLD_CHANGED", "The placement preconditions changed while equipping.");
    }
    const offset: Record<PlaceInput["face"], Position> = {
      top: { x: 0, y: 1, z: 0 }, bottom: { x: 0, y: -1, z: 0 }, north: { x: 0, y: 0, z: -1 },
      south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 },
    };
    const target = toVec3(input.referencePosition).plus(toVec3(offset[input.face]));
    const observed = new ServerBlockObservation(this.bot, target);
    try {
      // Await the actual Mineflayer promise even on cancellation. Executor retains the lock.
      const result = await this.placement.execute(this.placement.inputSchema.parse({ referencePosition: input.referencePosition, face: input.face }), this.context);
      signal.throwIfAborted();
      if (!result.ok) return result;
      await observed.wait(signal, BUILD_LIMITS.confirmationMs, (b) => b.name === block);
      if (!observed.matches((b) => b.name === block)) return failure("ACTION_NOT_CONFIRMED", "The server did not confirm the expected construction block. Observe before retrying.", {
        facts: { position: target, expected: block, observed: this.blockAt(target)?.name ?? null },
      });
      return result;
    } finally { observed.dispose(); }
  }
}
