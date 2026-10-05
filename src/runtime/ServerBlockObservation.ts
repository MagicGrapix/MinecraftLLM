import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { Position } from "../shared/types";

/** Watches inbound packets only: blockUpdate also includes optimistic client edits. */
export class ServerBlockObservation {
  stateId: number | null = null;
  private notify: (() => void) | null = null;

  constructor(private readonly bot: Bot, private readonly position: Vec3) {
    bot._client.on("block_change", this.onSingle);
    bot._client.on("multi_block_change", this.onMultiple);
  }

  private record(stateId: number): void {
    if (!Number.isSafeInteger(stateId) || stateId < 0) return;
    this.stateId = stateId;
    this.notify?.();
  }
  private readonly onSingle = (packet: { location: Position; type: number }): void => {
    if (packet.location.x === this.position.x && packet.location.y === this.position.y && packet.location.z === this.position.z) this.record(packet.type);
  };
  private readonly onMultiple = (packet: { chunkCoordinates?: Position; records: readonly (number | bigint)[] }): void => {
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

  private removalObserved(): boolean {
    const block = this.bot.blockAt(this.position);
    return this.stateId !== null && block?.stateId === this.stateId && block.boundingBox === "empty";
  }

  async wait(signal: AbortSignal, timeoutMs: number): Promise<void> {
    signal.throwIfAborted();
    if (this.removalObserved()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); this.notify = null;
        signal.removeEventListener("abort", aborted);
        this.bot.removeListener("end", ended);
      };
      const done = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      const ended = () => { cleanup(); reject(new Error("Connection ended while confirming dig.")); };
      const timer = setTimeout(done, timeoutMs);
      this.notify = done;
      signal.addEventListener("abort", aborted, { once: true });
      this.bot.on("end", ended);
    });
    signal.throwIfAborted();
  }

  dispose(): void {
    this.bot._client.removeListener("block_change", this.onSingle);
    this.bot._client.removeListener("multi_block_change", this.onMultiple);
  }
}
