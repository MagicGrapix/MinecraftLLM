import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { Movements } from "mineflayer-pathfinder";
import type { ExecutionContext } from "../capabilities/Capability";
import { DigCapability } from "../capabilities/Dig";
import { GotoCapability } from "../capabilities/Goto";
import { failure, success, type TaskResult } from "../execution/TaskResult";
import { isKnownBuildCell } from "../runtime/KnownBuildSites";
import type { NavigationInterceptor } from "../runtime/NavigationOperations";
import { ServerBlockObservation } from "../runtime/ServerBlockObservation";
import type { ServerInventoryConfirmation } from "../runtime/ServerInventoryConfirmation";
import { waitForConfirmation } from "../runtime/waitForConfirmation";
import { toVec3 } from "../runtime/PositionAdapter";
import type { Position } from "../shared/types";
import { COLLECTION_LIMITS as limits } from "./CollectionConfig";
import type { CollectionTrace } from "./CollectionTrace";

interface Scaffold { position: Vec3; stateId: number | null; owned: boolean; observation: ServerBlockObservation }
const full = (b: Block | null) => b?.shapes.length === 1 && b.shapes[0]!.every((n, i) => n === (i < 3 ? 0 : 1));
const air = (b: Block | null) => !!b && ["air", "cave_air", "void_air"].includes(b.name);
const key = (p: Position) => `${p.x},${p.y},${p.z}`;
const offsets = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];

/** Conservative pathfinder access: dirt only, known shallow ground, bounded edits, server-owned cleanup. */
export class CollectionTerrain {
  readonly scaffolds = new Map<string, Scaffold>();
  private placements = 0;
  private breaks = 0;
  private readonly dimension: string;
  constructor(private readonly context: ExecutionContext, private readonly inventory: ServerInventoryConfirmation,
    private readonly origin: Position, private readonly trace: CollectionTrace, private readonly changed: () => void) {
    this.dimension = this.bot.game.dimension;
  }
  private get bot() { return this.context.runtime.bot; }
  get left(): number { return this.scaffolds.size; }
  protected(p: Position): boolean {
    const b = this.bot.blockAt(toVec3(p));
    return isKnownBuildCell(this.context.runtime, this.dimension, p) || this.scaffolds.has(key(p)) || !!b &&
      (["crafting_table", "furnace", "blast_furnace", "smoker", "chest", "trapped_chest", "ender_chest", "barrel"].includes(b.name) ||
        b.name.endsWith("_bed") || b.name.endsWith("shulker_box"));
  }
  within(p: Position): boolean { return toVec3(p).distanceTo(toVec3(this.origin)) <= limits.maxRadius; }
  private shallowGround(p: Position): boolean {
    for (let depth = 1; depth <= limits.maxAccessHeight + 1; depth++) {
      const b = this.bot.blockAt(toVec3(p).offset(0, -depth, 0));
      if (!b || ["water", "lava"].includes(b.name)) return false;
      if (full(b)) return true;
      if (!air(b)) return false;
    }
    return false;
  }
  canBreak(block: Block, target: Position): boolean {
    if (this.breaks >= limits.maxObstacleBreaks || !this.within(block.position) || this.protected(block.position) || key(block.position) === key(target)) return false;
    if (!["dirt", "grass_block", "stone", "cobblestone"].includes(block.name) && !block.name.endsWith("_leaves")) return false;
    const feet = this.bot.entity.position;
    // Never mine a floor/exit for access. Resource extraction has its own preflight.
    if (block.position.y < Math.floor(feet.y) || !this.shallowGround(block.position)) return false;
    if (offsets.some(o => {
      const b = this.bot.blockAt(block.position.plus(o));
      return !b || ["water", "lava", "sand", "red_sand", "gravel"].includes(b.name);
    })) return false;
    return [this.bot.heldItem, null, ...this.bot.inventory.items()].some(i => block.canHarvest(i?.type ?? null));
  }
  canPlace(p: Position): boolean {
    const feet = this.bot.entity.position;
    const occupiedByBot = feet.x + 0.3 > p.x && feet.x - 0.3 < p.x + 1 &&
      feet.z + 0.3 > p.z && feet.z - 0.3 < p.z + 1 && feet.y < p.y + 1 && feet.y + 1.8 > p.y;
    return this.placements < limits.maxScaffoldPlacements && this.within(p) && !this.protected(p) &&
      !occupiedByBot && air(this.bot.blockAt(toVec3(p))) && this.shallowGround(p);
  }
  configureWalking(movements: Movements, anchor: Position): void {
    movements.allowParkour = false; movements.allowSprinting = false; movements.maxDropDown = limits.maxAccessHeight;
    for (const name of ["water", "lava"]) if (this.bot.registry.blocksByName[name]) movements.blocksToAvoid.add(this.bot.registry.blocksByName[name]!.id);
    // exclusionAreasStep also receives head-clearance cells: applying a feet-height limit there
    // prevents otherwise valid climbs. Filter actual movement nodes instead.
    const neighbors = movements.getNeighbors.bind(movements);
    movements.getNeighbors = node => neighbors(node).filter(p => this.within(p) &&
      Math.abs(p.y - Math.floor(anchor.y)) <= limits.maxAccessHeight && this.shallowGround(p));
  }

  policy(target: Position, anchor: Position, reservedDirt: number, signal: AbortSignal, reject: (message: string) => never) {
    const allowedHeight = (p: Position) => p.y <= anchor.y + limits.maxAccessHeight && p.y >= anchor.y - limits.maxAccessHeight;
    const configure = (movements: Movements) => {
      this.configureWalking(movements, anchor);
      // Prefer supported steps/bridges. Pathfinder's jump-under-foot towers are timing-sensitive
      // on this protocol and can issue a placement while the player's body still occupies it.
      movements.allow1by1towers = false;
      movements.scafoldingBlocks = [this.bot.registry.itemsByName.dirt!.id];
      const count = movements.countScaffoldingItems.bind(movements);
      movements.countScaffoldingItems = () => Math.max(0, Math.min(count() - reservedDirt, limits.maxScaffoldPlacements - this.placements));
      movements.exclusionAreasBreak.push(b => this.canBreak(b, target) ? 0 : 100);
      movements.exclusionAreasPlace.push(b => allowedHeight(b.position) && this.canPlace(b.position) ? 0 : 100);
    };
    const intercept: NavigationInterceptor = async (method, args, run) => {
      signal.throwIfAborted();
      if (this.bot.game.dimension !== this.dimension) return reject("Dimension changed during access.");
      if (method === "activateBlock") return reject("Collection does not activate blocks along the route.");
      if (method === "equip") return this.trace.run("path_equip", { item: (args[0] as { name?: string })?.name }, run);
      const reference = args[0] as Block;
      const position = method === "placeBlock" ? reference.position.plus(args[1] as Vec3) : reference.position;
      return this.trace.run(method === "dig" ? "path_dig" : "scaffold_place", { position, block: method === "dig" ? reference.name : "dirt" }, async () => {
        if (!allowedHeight(position)) return reject("Access height budget exceeded.");
        if (method === "dig") {
          const current = this.bot.blockAt(position);
          if (!current || current.stateId !== reference.stateId || !this.canBreak(current, target)) return reject("Unsafe or protected access obstacle.");
          if (!current.canHarvest(this.bot.heldItem?.type ?? null)) return reject("Access tool cannot harvest this obstacle.");
          this.breaks++;
          const observation = new ServerBlockObservation(this.bot, position);
          try {
            await run(); signal.throwIfAborted();
            if (!await waitForConfirmation(() => observation.matches(air), signal)) return reject("Access dig was not confirmed by the server.");
            return { confirmed: true, position };
          } finally { observation.dispose(); }
        }
        if (!this.canPlace(position) || this.bot.heldItem?.name !== "dirt") return reject("Unsafe scaffold position or missing dirt in hand.");
        // Reserve acquisition synchronized this snapshot; inbound slot packets keep it current.
        // Never wait for a resync here: pathfinder calls placeBlock during the tower jump.
        if (!this.inventory.snapshot || (this.inventory.snapshot.items.dirt ?? 0) <= reservedDirt) return reject("Scaffold dirt is unavailable or reserved for the collection objective.");
        if (!this.canPlace(position)) return reject("Scaffold destination changed before placement.");
        this.placements++;
        const entry: Scaffold = { position: position.clone(), stateId: null, owned: false, observation: undefined as never };
        entry.observation = new ServerBlockObservation(this.bot, position, state => {
          if (entry.owned && state !== entry.stateId) { entry.owned = false; this.changed(); }
        });
        this.scaffolds.set(key(position), entry); this.changed();
        // A rejected Mineflayer promise may still have placed the dirt; never send it twice.
        let cause: unknown;
        try { await run(); } catch (error) { cause = error; }
        signal.throwIfAborted();
        if (!await waitForConfirmation(() => entry.observation.matches(b => b.name === "dirt"), signal)) return reject(`Scaffold placement unconfirmed${cause ? `: ${String(cause)}` : "."}`);
        entry.stateId = entry.observation.stateId; entry.owned = true; this.changed();
        return { confirmed: true, position, stateId: entry.stateId };
      });
    };
    return { configure, intercept };
  }

  async cleanup(signal: AbortSignal): Promise<TaskResult> {
    const bot = this.bot;
    // Leave elevated supports until the bot has returned to an unmodified full-block floor.
    if (this.left) {
      signal.throwIfAborted();
      if (bot.game.dimension !== this.dimension) return failure("WORLD_CHANGED", "Scaffold world changed; no cleanup.");
      const floor = bot.entity.position.floored().offset(0, -1, 0);
      if (this.scaffolds.has(key(floor))) {
        const anchor = bot.entity.position.clone();
        const result = await this.trace.run("return_to_ground", { position: this.origin }, () => new GotoCapability({ configure: m => this.configureWalking(m, anchor) }).execute(
          { position: this.origin, range: 0, canDig: false, canPlace: false }, { ...this.context, signal }));
        if (!result.ok) return result;
      }
    }
    for (const entry of [...this.scaffolds.values()].sort((a, b) => b.position.y - a.position.y)) {
      signal.throwIfAborted();
      const block = bot.blockAt(entry.position);
      if (air(block) && entry.observation.stateId === block!.stateId) { entry.observation.dispose(); this.scaffolds.delete(key(entry.position)); this.changed(); continue; }
      if (!entry.owned || !block || block.stateId !== entry.stateId || block.name !== "dirt") continue;
      // Cleanup only from existing ground; never remove our current footing or climb to remove stairs.
      const feet = bot.entity.position, floor = feet.floored().offset(0, -1, 0);
      if (!bot.entity.onGround || !full(bot.blockAt(floor)) || this.scaffolds.has(key(floor)) ||
          feet.x + 0.3 > entry.position.x && feet.x - 0.3 < entry.position.x + 1 && feet.z + 0.3 > entry.position.z && feet.z - 0.3 < entry.position.z + 1 && entry.position.y < feet.y) continue;
      if (!this.context.world.getBlockAccess(entry.position).canDig) continue;
      const result = await this.trace.run("scaffold_remove", { position: entry.position, stateId: entry.stateId }, () => new DigCapability().execute({ position: entry.position }, { ...this.context, signal }));
      if (result.ok) { entry.observation.dispose(); this.scaffolds.delete(key(entry.position)); this.changed(); }
    }
    this.trace.emit({ event: "scaffolds_remaining", positions: [...this.scaffolds.values()].map(e => ({ position: e.position, owned: e.owned, stateId: e.stateId })) });
    return this.left ? failure("BLOCKED", "Some temporary blocks could not be safely removed.", { facts: { left: this.left } }) : success({ removed: true });
  }
  dispose(): void {
    this.trace.emit({ event: "scaffolds_remaining", positions: [...this.scaffolds.values()].map(e => ({ position: e.position, owned: e.owned, stateId: e.stateId })) });
    for (const entry of this.scaffolds.values()) entry.observation.dispose();
  }
}
