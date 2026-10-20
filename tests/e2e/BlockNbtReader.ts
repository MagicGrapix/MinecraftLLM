import type { Bot } from "mineflayer";
import { inspect } from "node:util";
import type { Position } from "../../src/shared/types";
import type { ContainerObservation } from "./types";

export class NbtObservationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** OP controller only. Reads authoritative block data without opening a GUI or sending chat. */
export class BlockNbtReader {
  private transactionId = 0;
  constructor(private readonly client: Bot["_client"], private readonly timeoutMs = 2_000) {}

  read(position: Position): Promise<unknown> {
    const transactionId = ++this.transactionId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.client.removeListener("nbt_query_response", received);
        this.client.removeListener("end", ended);
      };
      const received = (packet: { transactionId: number; nbt: unknown }) => {
        if (packet.transactionId !== transactionId) return;
        cleanup(); resolve(packet.nbt);
      };
      const ended = () => { cleanup(); reject(new NbtObservationError("CONTROLLER_DISCONNECTED", "Controller disconnected during container observation.")); };
      const timer = setTimeout(() => {
        cleanup(); reject(new NbtObservationError("NBT_QUERY_TIMEOUT", `Container NBT query timed out at (${position.x}, ${position.y}, ${position.z}); check controller OP permissions.`));
      }, this.timeoutMs);
      this.client.on("nbt_query_response", received);
      this.client.on("end", ended);
      try { this.client.write("query_block_nbt", { transactionId, location: position }); }
      catch (error) { cleanup(); reject(new NbtObservationError("NBT_QUERY_WRITE_FAILED", String(error))); }
    });
  }
}

/** Modern Java chest NBT. Missing/malformed data is unknown, never an empty inventory. */
export type ContainerInventoryResult = { ok: true; inventory: Record<string, number> }
  | { ok: false; error: NonNullable<ContainerObservation["error"]> };

export function chestInventory(nbt: unknown, observedBlock: string | null = null): ContainerInventoryResult {
  const invalid = (path: string, message: string): ContainerInventoryResult => ({ ok: false, error: {
    code: "INVALID_CHEST_NBT", path, message,
    sample: inspect(nbt, { depth: 4, maxArrayLength: 8, maxStringLength: 160, breakLength: Infinity }).slice(0, 2_000),
  } });
  const root = tag(nbt, "compound");
  if (!root || typeof root !== "object") return invalid("$", "Expected a compound NBT root; chest contents are unknown.");
  const fields = root as Record<string, unknown>;
  // Java 1.21.11 query_block_nbt omits block-entity metadata, including id.
  // In that case identity must come from an independently observed chest block.
  if (Object.hasOwn(fields, "id")) {
    if (tag(fields.id, "string") !== "minecraft:chest") return invalid("$.id", "Expected string tag minecraft:chest.");
  } else if (observedBlock !== "chest") {
    return invalid("$.id", "NBT has no id; an observed chest block is required to establish identity.");
  }
  const list = tag(fields.Items, "list") as { type?: unknown; value?: unknown } | null;
  if (!list || !Array.isArray(list.value) || (list.value.length > 0 && list.type !== "compound")) return invalid("$.Items", "Expected a list of item compounds (an explicit empty list is allowed).");
  const totals = new Map<string, number>();
  for (const [index, raw] of list.value.entries()) {
    if (!raw || typeof raw !== "object") return invalid(`$.Items[${index}]`, "Expected an item compound.");
    const item = raw as Record<string, unknown>;
    const id = tag(item.id, "string");
    const count = Object.hasOwn(item, "count") ? tag(item.count, "int") : 1;
    if (typeof id !== "string" || !/^minecraft:[a-z0-9_]+$/.test(id)
        || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return invalid(`$.Items[${index}]`, "Expected a minecraft item id and a positive integer count (default 1 if absent).");
    const name = id.slice("minecraft:".length);
    totals.set(name, (totals.get(name) ?? 0) + count);
  }
  return { ok: true, inventory: Object.fromEntries(totals) };
}

/** Separate furnace contract: exactly three logical slots; no chest-shaped fallback. */
export function furnaceInventory(nbt: unknown, observedBlock: string | null): ContainerInventoryResult {
  const invalid = (path: string, message: string): ContainerInventoryResult => ({ ok: false, error: {
    code: "INVALID_FURNACE_NBT", path, message,
    sample: inspect(nbt, { depth: 4, maxArrayLength: 4, maxStringLength: 160 }).slice(0, 2_000),
  } });
  const fields = tag(nbt, "compound") as Record<string, unknown> | null;
  if (!fields || typeof fields !== "object" || observedBlock !== "furnace") return invalid("$", "An observed furnace and compound NBT are required.");
  if (Object.hasOwn(fields, "id") && tag(fields.id, "string") !== "minecraft:furnace") return invalid("$.id", "Expected a furnace block entity.");
  const list = tag(fields.Items, "list") as { type?: unknown; value?: unknown } | null;
  if (!list || !Array.isArray(list.value) || (list.value.length > 0 && list.type !== "compound")) return invalid("$.Items", "Expected an explicit list of furnace items.");
  const slots = new Set<number>(), inventory: Record<string, number> = {};
  for (const [index, raw] of list.value.entries()) {
    if (!raw || typeof raw !== "object") return invalid(`$.Items[${index}]`, "Expected a furnace item compound.");
    const item = raw as Record<string, unknown>, slot = tag(item.Slot, "byte");
    const id = tag(item.id, "string"), count = Object.hasOwn(item, "count") ? tag(item.count, "int") : 1;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 2 || slots.has(slot) ||
      typeof id !== "string" || !/^minecraft:[a-z0-9_]+$/.test(id) ||
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 64) {
      return invalid(`$.Items[${index}]`, "Expected unique slot 0..2, Minecraft item id and count 1..64.");
    }
    slots.add(slot);
    const name = id.slice("minecraft:".length);
    inventory[name] = (inventory[name] ?? 0) + count;
  }
  return { ok: true, inventory };
}

function tag(value: unknown, type: string): unknown {
  if (!value || typeof value !== "object") return null;
  const node = value as { type?: unknown; value?: unknown };
  return node.type === type ? node.value : null;
}
