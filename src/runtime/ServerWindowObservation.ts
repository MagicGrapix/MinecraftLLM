import type { Bot } from "mineflayer";
import type { Window } from "prismarine-windows";
import { ACTION_CONFIRMATION } from "../config";
import { waitForConfirmation, type ConfirmationTiming } from "./waitForConfirmation";

export interface WindowStack { item: string; count: number }
interface NetworkStack { itemId?: number; itemCount: number }
export interface WindowSnapshot {
  slots: (WindowStack | null)[];
  cursor: WindowStack | null;
  properties: Record<number, number>;
  revision: number;
}

/** Observe inbound packets only. Attach before opening: initial contents/properties may arrive early. */
export class ServerWindowObservation {
  private readonly states = new Map<number, WindowSnapshot>();
  private window: Window | null = null;
  private invalid: Error | null = null;
  private revision = 0;
  constructor(private readonly bot: Bot, private readonly timing: ConfirmationTiming = ACTION_CONFIRMATION) {
    if (bot.version !== "1.21.11") throw new Error("Station confirmations support Minecraft Java 1.21.11.");
    bot._client.on("window_items", this.onItems);
    bot._client.on("set_slot", this.onSlot);
    bot._client.on("set_cursor_item", this.onCursor);
    bot._client.on("craft_progress_bar", this.onProperty);
  }
  bind(window: Window): void { this.window = window; }
  snapshot(): WindowSnapshot | null {
    if (this.invalid) throw this.invalid;
    const state = this.window && this.states.get(this.window.id);
    if (!state || state.slots.length !== this.window!.slots.length) return null;
    return structuredClone(state);
  }
  async synchronize(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const window = this.window;
    if (!window || this.bot.currentWindow !== window) throw new Error("The station window is no longer available.");
    const before = this.revision;
    // Same bounded no-op resync as ServerInventoryConfirmation; never repeats an item transfer.
    this.bot._client.write("window_click", {
      windowId: window.id, stateId: -1, slot: -999, mouseButton: 2, mode: 5,
      changedSlots: [], cursorItem: null,
    });
    return waitForConfirmation(() => {
      if (this.bot.currentWindow !== window) throw new Error("The station window was closed or replaced.");
      const state = this.snapshot();
      return state !== null && state.revision > before;
    }, signal, this.timing);
  }
  dispose(): void {
    this.bot._client.removeListener("window_items", this.onItems);
    this.bot._client.removeListener("set_slot", this.onSlot);
    this.bot._client.removeListener("set_cursor_item", this.onCursor);
    this.bot._client.removeListener("craft_progress_bar", this.onProperty);
  }
  private stack(raw: NetworkStack): WindowStack | null {
    if (raw?.itemCount === 0) return null;
    const item = raw && this.bot.registry.items[raw.itemId!];
    if (!item || !Number.isSafeInteger(raw.itemCount) || raw.itemCount < 1) throw new Error("Invalid server station contents.");
    return { item: item.name, count: raw.itemCount };
  }
  private receive(action: () => void): void {
    try { action(); } catch (error) { this.invalid = error instanceof Error ? error : new Error(String(error)); }
  }
  private relevant(id: number): boolean { return id > 0 && (!this.window || this.window.id === id); }
  private readonly onItems = (packet: { windowId: number; items: NetworkStack[]; carriedItem: NetworkStack }) => {
    if (!this.relevant(packet.windowId)) return;
    this.receive(() => {
      const properties = this.states.get(packet.windowId)?.properties ?? {};
      this.states.set(packet.windowId, { slots: packet.items.map(item => this.stack(item)),
        cursor: this.stack(packet.carriedItem), properties, revision: ++this.revision });
    });
  };
  private readonly onSlot = (packet: { windowId: number; slot: number; item: NetworkStack }) => {
    if (!this.relevant(packet.windowId)) return;
    this.receive(() => {
      const state = this.states.get(packet.windowId);
      if (!state) return;
      if (!Number.isInteger(packet.slot) || packet.slot < 0 || packet.slot >= state.slots.length) throw new Error("Invalid station slot update.");
      state.slots[packet.slot] = this.stack(packet.item);
    });
  };
  private readonly onCursor = (packet: { contents: NetworkStack }) => {
    if (this.window && this.bot.currentWindow === this.window) this.receive(() => {
      const state = this.states.get(this.window!.id);
      if (state) state.cursor = this.stack(packet.contents);
    });
  };
  private readonly onProperty = (packet: { windowId: number; property: number; value: number }) => {
    if (!this.relevant(packet.windowId)) return;
    const state = this.states.get(packet.windowId) ?? { slots: [], cursor: null, properties: {}, revision: 0 };
    if (Number.isFinite(packet.value)) state.properties[packet.property] = packet.value;
    this.states.set(packet.windowId, state);
  };
}

export function windowTotals(slots: readonly (WindowStack | null)[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const stack of slots) if (stack) result[stack.item] = (result[stack.item] ?? 0) + stack.count;
  return result;
}

export function windowCapacity(slots: readonly (WindowStack | null)[], item: string, stackSize: number): number {
  return slots.reduce((n, slot) => n + (slot === null ? stackSize : slot.item === item ? Math.max(0, stackSize - slot.count) : 0), 0);
}
