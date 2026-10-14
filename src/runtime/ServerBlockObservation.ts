import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { Block } from "prismarine-block";
import type { Position } from "../shared/types";

interface SingleChange { location: Position; type: number }
interface MultipleChanges { chunkCoordinates?: Position; records: readonly (number | bigint)[] }

/** Watches inbound packets only: blockUpdate also includes optimistic client edits. */
export class ServerBlockObservation {
  private static readonly streams = new WeakMap<Bot, { observers: Set<ServerBlockObservation>; single: (packet: SingleChange) => void; multiple: (packet: MultipleChanges) => void }>();
  stateId: number | null = null;
  private notify: (() => void) | null = null;

  constructor(private readonly bot: Bot, private readonly position: Vec3, private readonly changed?: (stateId: number) => void) {
    let stream = ServerBlockObservation.streams.get(bot);
    if (!stream) {
      const observers = new Set<ServerBlockObservation>();
      stream = { observers, single: packet => { for (const observer of observers) observer.onSingle(packet); },
        multiple: packet => { for (const observer of observers) observer.onMultiple(packet); } };
      ServerBlockObservation.streams.set(bot, stream);
      bot._client.on("block_change", stream.single);
      bot._client.on("multi_block_change", stream.multiple);
    }
    stream.observers.add(this);
  }

  private record(stateId: number): void {
    if (!Number.isSafeInteger(stateId) || stateId < 0) return;
    this.stateId = stateId;
    this.changed?.(stateId);
    this.notify?.();
  }
  private readonly onSingle = (packet: SingleChange): void => {
    if (packet.location.x === this.position.x && packet.location.y === this.position.y && packet.location.z === this.position.z) this.record(packet.type);
  };
  private readonly onMultiple = (packet: MultipleChanges): void => {
    const section = packet.chunkCoordinates;
    // Java 1.21.11 format. Unknown formats cannot confirm removal.
    if (!section || section.x !== Math.floor(this.position.x / 16) || section.y !== Math.floor(this.position.y / 16) || section.z !== Math.floor(this.position.z / 16)) return;
    for (const raw of packet.records) {
      if (typeof raw !== "bigint" && !Number.isSafeInteger(raw)) continue;
      const record = BigInt(raw);
      if (section.x * 16 + Number((record >> 8n) & 15n) === this.position.x &&
        section.y * 16 + Number(record & 15n) === this.position.y &&
        section.z * 16 + Number((record >> 4n) & 15n) === this.position.z) this.record(Number(record >> 12n));
    }
  };

  matches(predicate: (block: Block) => boolean): boolean {
    const block = this.bot.blockAt(this.position);
    return this.stateId !== null && !!block && block.stateId === this.stateId && predicate(block);
  }

  async wait(signal: AbortSignal, timeoutMs: number, predicate = (block: Block) => block.boundingBox === "empty"): Promise<void> {
    signal.throwIfAborted();
    if (this.matches(predicate)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); this.notify = null;
        signal.removeEventListener("abort", aborted);
        this.bot.removeListener("end", ended);
      };
      const done = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      const ended = () => { cleanup(); reject(new Error("Connection ended while confirming a block change.")); };
      const timer = setTimeout(done, timeoutMs);
      this.notify = () => { if (this.matches(predicate)) done(); };
      signal.addEventListener("abort", aborted, { once: true });
      this.bot.on("end", ended);
    });
    signal.throwIfAborted();
  }

  dispose(): void {
    const stream = ServerBlockObservation.streams.get(this.bot);
    stream?.observers.delete(this);
    if (stream && stream.observers.size === 0) {
      this.bot._client.removeListener("block_change", stream.single);
      this.bot._client.removeListener("multi_block_change", stream.multiple);
      ServerBlockObservation.streams.delete(this.bot);
    }
  }
}
