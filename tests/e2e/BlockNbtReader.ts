import type { Bot } from "mineflayer";
import type { Position } from "../../src/shared/types";

/** OP controller only. Reads authoritative chest data without opening a GUI or sending chat. */
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
      const ended = () => { cleanup(); reject(new Error("Controller disconnected during chest observation.")); };
      const timer = setTimeout(() => {
        cleanup(); reject(new Error(`Chest NBT query timed out at (${position.x}, ${position.y}, ${position.z}); check controller OP permissions.`));
      }, this.timeoutMs);
      this.client.on("nbt_query_response", received);
      this.client.on("end", ended);
      try { this.client.write("query_block_nbt", { transactionId, location: position }); }
      catch (error) { cleanup(); reject(error); }
    });
  }
}

/** Modern Java chest NBT. Missing/malformed data is unknown, never an empty inventory. */
export function chestInventory(nbt: unknown): Record<string, number> | null {
  const root = tag(nbt, "compound");
  if (!root || typeof root !== "object") return null;
  const fields = root as Record<string, unknown>;
  if (tag(fields.id, "string") !== "minecraft:chest") return null;
  const list = tag(fields.Items, "list") as { type?: unknown; value?: unknown } | null;
  if (!list || !Array.isArray(list.value) || (list.value.length > 0 && list.type !== "compound")) return null;
  const totals = new Map<string, number>();
  for (const raw of list.value) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const id = tag(item.id, "string");
    const count = Object.hasOwn(item, "count") ? tag(item.count, "int") : 1;
    if (typeof id !== "string" || !/^minecraft:[a-z0-9_]+$/.test(id)
        || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return null;
    const name = id.slice("minecraft:".length);
    totals.set(name, (totals.get(name) ?? 0) + count);
  }
  return Object.fromEntries(totals);
}

function tag(value: unknown, type: string): unknown {
  if (!value || typeof value !== "object") return null;
  const node = value as { type?: unknown; value?: unknown };
  return node.type === type ? node.value : null;
}
