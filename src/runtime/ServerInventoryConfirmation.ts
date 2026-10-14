import type { Bot } from "mineflayer";
import { ACTION_CONFIRMATION } from "../config";
import { inventoryTotals } from "./InventoryAdapter";
import { waitForConfirmation, type ConfirmationTiming } from "./waitForConfirmation";

interface Stack { name: string; count: number }
interface NetworkStack { itemCount: number; itemId?: number }
export interface ConfirmedInventory {
  items: Readonly<Record<string, number>>;
  crafting: readonly (Stack | null)[];
  cursor: Stack | null;
}

export class InventoryObservationError extends Error {}

/** Java 1.21.11: only inbound inventory packets supply evidence, never predicted updateSlot events. */
export class ServerInventoryConfirmation {
  private slots: (Stack | null)[] | null = null;
  private cursor: Stack | null = null;
  private readonly unavailable = new AbortController();

  constructor(private readonly bot: Bot, private readonly timing: ConfirmationTiming = ACTION_CONFIRMATION) {
    if (bot.version !== "1.21.11") {
      throw new InventoryObservationError("Server inventory confirmation is currently verified for Java 1.21.11 only.");
    }
    bot._client.on("window_items", this.onItems);
    bot._client.on("set_slot", this.onSlot);
    bot._client.on("set_player_inventory", this.onPlayerSlot);
    bot._client.on("set_cursor_item", this.onCursor);
    bot.on("end", this.onEnd);
    bot.on("death", this.onEnd);
    bot.on("respawn", this.onEnd);
  }

  get snapshot(): ConfirmedInventory | null {
    if (!this.slots || this.unavailable.signal.aborted) return null;
    return {
      items: inventoryTotals(this.slots.slice(this.bot.inventory.inventoryStart, this.bot.inventory.inventoryEnd)
        .filter((item): item is Stack => item !== null)),
      crafting: this.slots.slice(0, 5).map(item => item && { ...item }),
      cursor: this.cursor && { ...this.cursor },
    };
  }

  /** Capacity for ordinary stackable resources; special NBT/component variants may stack differently. */
  capacity(item: string, stackSize: number): number | null {
    if (!this.slots || this.unavailable.signal.aborted) return null;
    return this.slots.slice(this.bot.inventory.inventoryStart, this.bot.inventory.inventoryEnd)
      .reduce((sum, slot) => sum + (slot === null ? stackSize : slot.name === item ? Math.max(0, stackSize - slot.count) : 0), 0);
  }

  async synchronize(signal: AbortSignal, accepts: (state: ConfirmedInventory) => boolean = () => true): Promise<boolean> {
    const connectedSignal = AbortSignal.any([signal, this.unavailable.signal]);
    connectedSignal.throwIfAborted();
    if (this.bot.currentWindow) throw new InventoryObservationError("A window is still open; cannot confirm the player inventory.");
    this.slots = null; // Require a new complete server snapshot after the last craft, not an old observation.
    // Same no-op used by Mineflayer's syncWindow: end an unstarted drag with a stale state ID.
    // It requests a full resync without moving items. Polling below sends no further packets.
    this.bot._client.write("window_click", {
      windowId: 0, stateId: -1, slot: -999, mouseButton: 2, mode: 5,
      changedSlots: [], cursorItem: null,
    });
    try {
      return await waitForConfirmation(() => {
        const state = this.snapshot;
        return state !== null && accepts(state);
      }, connectedSignal, this.timing);
    } catch (error) {
      signal.throwIfAborted();
      this.unavailable.signal.throwIfAborted();
      throw error;
    }
  }

  dispose(): void {
    this.bot._client.removeListener("window_items", this.onItems);
    this.bot._client.removeListener("set_slot", this.onSlot);
    this.bot._client.removeListener("set_player_inventory", this.onPlayerSlot);
    this.bot._client.removeListener("set_cursor_item", this.onCursor);
    this.bot.removeListener("end", this.onEnd);
    this.bot.removeListener("death", this.onEnd);
    this.bot.removeListener("respawn", this.onEnd);
  }

  private stack(raw: NetworkStack): Stack | null {
    if (raw?.itemCount === 0) return null;
    const item = raw && this.bot.registry.items[raw.itemId!];
    if (!item || !Number.isSafeInteger(raw.itemCount) || raw.itemCount < 1) {
      throw new InventoryObservationError("Malformed server inventory item; inventory is unknown.");
    }
    return { name: item.name, count: raw.itemCount };
  }
  private receive(update: () => void): void {
    try { update(); }
    catch (error) { this.unavailable.abort(error); }
  }
  private readonly onItems = (packet: { windowId: number; items: NetworkStack[]; carriedItem: NetworkStack }): void => {
    if (packet.windowId !== 0) return;
    this.receive(() => {
      if (packet.items.length !== this.bot.inventory.slots.length) throw new InventoryObservationError("Incomplete server inventory snapshot.");
      const slots = packet.items.map(item => this.stack(item));
      this.cursor = this.stack(packet.carriedItem);
      this.slots = slots;
    });
  };
  private readonly onSlot = (packet: { windowId: number; slot: number; item: NetworkStack }): void => {
    if (packet.windowId !== 0 || !this.slots || packet.slot < 0 || packet.slot >= this.slots.length) return;
    this.receive(() => { this.slots![packet.slot] = this.stack(packet.item); });
  };
  private readonly onPlayerSlot = (packet: { slotId: number; contents: NetworkStack }): void => {
    if (!Number.isInteger(packet.slotId) || packet.slotId < 0 || packet.slotId > 40) return;
    const slot = packet.slotId <= 8 ? packet.slotId + 36 : packet.slotId <= 35 ? packet.slotId
      : packet.slotId <= 39 ? 44 - packet.slotId : packet.slotId === 40 ? 45 : -1;
    this.onSlot({ windowId: 0, slot, item: packet.contents });
  };
  private readonly onCursor = (packet: { contents: NetworkStack }): void => {
    if (this.slots) this.receive(() => { this.cursor = this.stack(packet.contents); });
  };
  private readonly onEnd = (): void => {
    this.unavailable.abort(new InventoryObservationError("Connection or player state changed while confirming inventory."));
  };
}

export function hasEmptyCraftingArea(state: ConfirmedInventory): boolean {
  return state.cursor === null && state.crafting.every(item => item === null);
}
