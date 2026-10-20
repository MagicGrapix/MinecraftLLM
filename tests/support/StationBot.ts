import { EventEmitter } from "node:events";
import MinecraftData from "minecraft-data";
import type { Bot, Furnace } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Window } from "prismarine-windows";
import { Vec3 } from "vec3";
import type { ExecutionContext } from "../../src/capabilities/Capability";
import type { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import type { WorldQueries } from "../../src/world/WorldQueries";
import type { WindowStack } from "../../src/runtime/ServerWindowObservation";

const registry = MinecraftData("1.21.11");
export const stationTiming = { pollIntervalMs: 1, timeoutMs: 200 };
export function stationBot(kind: "chest" | "furnace" = "chest") {
  const events = new EventEmitter(), client = new EventEmitter();
  const start = kind === "chest" ? 27 : 3;
  const cells = new Map<string, Block>();
  const inventory: (WindowStack | null)[] = Array.from({ length: 36 }, () => null);
  const contents: (WindowStack | null)[] = Array.from({ length: start }, () => null);
  const calls: string[] = [], barriers: Promise<unknown>[] = [], progress: Record<string, unknown>[] = [];
  const abort = new AbortController();
  const options = { ignoreTransfer: false, transferLimit: Infinity, rejectTransfer: false,
    suppressSync: false, syncDelay: 0, noCooking: false, openDelay: 0, closeFails: false,
    cursor: null as WindowStack | null, beforeTransfer: null as (() => void) | null };
  const packet = (stack: WindowStack | null) => stack
    ? { itemId: registry.itemsByName[stack.item]!.id, itemCount: stack.count } : { itemCount: 0 };
  function block(name: string, position: Vec3, type = "single"): Block {
    return { name, position, type: registry.blocksByName[name]!.id, boundingBox: name === "air" ? "empty" : "block",
      shapes: name === "air" ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ type }) } as unknown as Block;
  }
  const target = block(kind, new Vec3(3, 64, 0));
  cells.set(target.position.toString(), target);
  let current: Window | null = null;
  const window = Object.assign(new EventEmitter(), {
    id: 7, type: kind === "chest" ? "minecraft:generic_9x3" : "minecraft:furnace",
    inventoryStart: start, inventoryEnd: start + 36, slots: Array(start + 36).fill(null),
    close: async () => { calls.push("close"); if (options.closeFails) throw new Error("cannot close");
      if (current === window as unknown as Window) current = null;
      window.emit("close"); events.emit("windowClose", window); },
    putInput: async (_type: number, _meta: unknown, count: number) => {
      calls.push("input"); remove("raw_iron", count); contents[0] = { item: "raw_iron", count }; emit();
    },
    putFuel: async (_type: number, _meta: unknown, count: number) => {
      calls.push("fuel"); remove("coal", count); contents[1] = { item: "coal", count }; emit();
      if (!options.noCooking) {
        contents[2] = { item: "iron_ingot", count: contents[0]!.count };
        contents[0] = null; contents[1] = count > 1 ? { item: "coal", count: count - 1 } : null; emit();
      }
    },
    takeOutput: async () => { calls.push("output"); add(contents[2]!.item, contents[2]!.count); contents[2] = null; emit(); },
  });
  function remove(item: string, count: number) {
    for (let i = 0; i < inventory.length && count > 0; i++) {
      const slot = inventory[i];
      if (slot?.item !== item) continue;
      const n = Math.min(count, slot.count); count -= n; slot.count -= n;
      if (!slot.count) inventory[i] = null;
    }
    if (count) throw new Error("insufficient fake inventory");
  }
  function add(item: string, count: number) {
    let i = inventory.findIndex(slot => slot?.item === item && slot.count + count <= 64);
    if (i < 0) i = inventory.indexOf(null);
    if (i < 0) throw new Error("fake inventory full");
    inventory[i] = { item, count: (inventory[i]?.count ?? 0) + count };
  }
  function emit() { client.emit("window_items", { windowId: 7, items: [...contents, ...inventory].map(packet), carriedItem: packet(options.cursor) }); }
  Object.assign(client, {
    write: (name: string, value: { windowId: number }) => {
      calls.push(name);
      if (name !== "window_click" || options.suppressSync) return;
      const send = () => value.windowId === 7 ? emit() : client.emit("window_items",
        { windowId: 0, items: [...Array(9).fill(null), ...inventory, null].map(packet), carriedItem: packet(options.cursor) });
      if (options.syncDelay) setTimeout(send, options.syncDelay); else send();
    },
  });
  const open = async () => {
    calls.push("open");
    if (options.openDelay) await new Promise(resolve => setTimeout(resolve, options.openDelay));
    current = window as unknown as Window;
    client.emit("open_window", { windowId: 7 });
    emit();
    client.emit("craft_progress_bar", { windowId: 7, property: 0, value: 0 });
    client.emit("craft_progress_bar", { windowId: 7, property: 3, value: 200 });
    client.emit("craft_progress_bar", { windowId: 7, property: 2, value: 0 });
    return window as unknown as Furnace;
  };
  const bot = Object.assign(events, {
    _client: client, version: "1.21.11", registry, game: { dimension: "overworld" },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, onGround: false },
    world: { getColumn: () => ({}) }, inventory: { inventoryStart: 9, inventoryEnd: 45, slots: Array(46).fill(null) },
    blockAt: (p: Vec3) => cells.get(p.floored().toString()) ?? block("air", p.floored()),
    lookAt: async () => { calls.push("look"); }, openContainer: open, openFurnace: open,
    closeWindow: window.close,
    transfer: async (input: { count: number; sourceStart: number; itemType: number }) => {
      calls.push("transfer"); options.beforeTransfer?.();
      const count = Math.min(input.count, options.transferLimit), item = registry.items[input.itemType]!.name;
      if (!options.ignoreTransfer) {
        if (input.sourceStart === start) {
          remove(item, count); const i = contents.findIndex(c => c?.item === item);
          const slot = i >= 0 ? i : contents.indexOf(null);
          contents[slot] = { item, count: (contents[slot]?.count ?? 0) + count };
        } else {
          let left = count;
          for (let i = 0; i < contents.length && left; i++) {
            const slot = contents[i];
            if (slot?.item !== item) continue;
            const n = Math.min(left, slot.count); left -= n; slot.count -= n;
            if (!slot.count) contents[i] = null;
          }
          add(item, count);
        }
      }
      emit();
      if (options.rejectTransfer) throw new Error("native transaction failed after transfer");
    },
    setControlState: () => { throw new Error("must not move"); },
  }) as unknown as Bot;
  Object.defineProperty(bot, "currentWindow", { get: () => current, set: (value: Window | null) => { current = value; } });
  const context: ExecutionContext = {
    runtime: { bot } as MinecraftRuntime, world: {} as WorldQueries, signal: abort.signal,
    deferCancellationUntil: p => barriers.push(p), reportProgress: f => progress.push(structuredClone(f)),
  };
  return { bot, window, client, context, abort, calls, cells, block, inventory, contents, options, barriers, progress, emit };
}
