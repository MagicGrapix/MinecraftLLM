import type { Bot, Furnace } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Window } from "prismarine-windows";
import { ACTION_CONFIRMATION, STATION_LIMITS } from "../config";
import type { ExecutionContext } from "../capabilities/Capability";
import { failure, type TaskResult, type TaskErrorCode } from "../execution/TaskResult";
import { findBlocksCooperatively } from "../world/BlockSearch";
import { inspectInteractionAccess } from "../world/BlockAccess";
import { fromVec3 } from "./PositionAdapter";
import { ServerWindowObservation, windowTotals, type WindowSnapshot } from "./ServerWindowObservation";
import { ServerInventoryConfirmation } from "./ServerInventoryConfirmation";
import { waitForConfirmation, type ConfirmationTiming } from "./waitForConfirmation";
import { writeTrace } from "../TraceLog";
import { errorMessage } from "../shared/helper";

export type StationKind = "chest" | "furnace";
export type StationResult = Record<string, unknown>;
export class StationError extends Error {
  constructor(readonly code: TaskErrorCode, message: string) { super(message); }
}
export interface StationSession {
  bot: Bot;
  window: Window;
  signal: AbortSignal;
  observation: ServerWindowObservation;
  snapshot(): WindowSnapshot;
  refresh(): Promise<WindowSnapshot>;
  attempt(label: string, operation: () => Promise<unknown>): Promise<WindowSnapshot>;
  progress(facts: Record<string, unknown>): void;
  expectInventory(items: Record<string, number>): void;
}

/** Local selection only; no look, movement, or window side effects. */
export async function selectStation(bot: Bot, kind: StationKind, signal: AbortSignal): Promise<TaskResult<Block>> {
  const id = bot.registry.blocksByName[kind]?.id;
  if (id === undefined) return failure("INVALID_ARGUMENT", `Unsupported station type: ${kind}.`);
  const candidates = await findBlocksCooperatively(bot, new Set([id]), {
    maxDistance: STATION_LIMITS.searchRadius, count: 128, signal,
  });
  const inspected = candidates.map(block => ({ block, access: inspectInteractionAccess(bot, block.position, STATION_LIMITS.interactionReach) }));
  // At the search cap we cannot prove there is a unique accessible target.
  const accessible = inspected.filter(c => c.access.accessible);
  if (accessible.length > 1 || candidates.length === 128) return failure("BLOCKED",
    `Several ${kind}s may be accessible. Move closer to the intended ${kind}.`, {
      facts: { reason: "ambiguous_target", positions: accessible.slice(0, 4).map(c => fromVec3(c.block.position)) },
    });
  const chosen = accessible[0];
  if (chosen) {
    if (kind === "chest" && chosen.block.getProperties().type !== "single") return failure("BLOCKED",
      "Only a single ordinary chest is supported. Use a separate single chest.", { facts: { position: fromVec3(chosen.block.position) } });
    return { ok: true, value: chosen.block };
  }
  const near = inspected[0];
  if (!near) return failure("TARGET_NOT_FOUND", `No loaded ${kind} found within ${STATION_LIMITS.searchRadius} blocks. Find one and approach it.`);
  const { aim: _aim, ...access } = near.access;
  return failure(near.access.reason === "out_of_reach" ? "OUT_OF_REACH" : "BLOCKED",
    `The nearby ${kind} is not accessible. Move within reach with a clear view.`, {
      facts: { position: fromVec3(near.block.position), ...access },
    });
}

/** One physical lifetime, including late native completion and cleanup. No nested Executor or public session. */
export function withStation(
  kind: StationKind, context: ExecutionContext,
  action: (session: StationSession) => Promise<TaskResult<StationResult>>,
  timing: ConfirmationTiming = ACTION_CONFIRMATION,
): Promise<TaskResult<StationResult>> {
  const operation = runStation(kind, context, action, timing);
  context.deferCancellationUntil(operation);
  return operation;
}

async function runStation(kind: StationKind, context: ExecutionContext,
  action: (session: StationSession) => Promise<TaskResult<StationResult>>, timing: ConfirmationTiming,
): Promise<TaskResult<StationResult>> {
  const bot = context.runtime.bot;
  const currentWindow = (): Window | null => bot.currentWindow;
  if (currentWindow()) return failure("BLOCKED", "Another inventory window is already open; it was left unchanged.");
  const selected = await selectStation(bot, kind, context.signal);
  if (!selected.ok) return selected;
  if (currentWindow()) return failure("BLOCKED", "Another inventory window opened during selection; it was left unchanged.");
  const block = selected.value, position = fromVec3(block.position);
  let owned: Window | null = null;
  let expectedInventory: Record<string, number> | null = null;
  let facts: Record<string, unknown> = { position, closed: false };
  const progress = (next: Record<string, unknown>) => {
    facts = { ...facts, ...next };
    context.reportProgress?.(facts);
  };
  const trace = (phase: string, detail: unknown = {}) => writeTrace("station.operation", { taskId: context.taskId, kind, position, phase, detail });
  const unavailable = new AbortController();
  const lost = () => unavailable.abort(new StationError("WORLD_CHANGED", "Connection or player state changed; station contents may have changed."));
  const signal = AbortSignal.any([context.signal, unavailable.signal]);
  let observation: ServerWindowObservation;
  try { observation = new ServerWindowObservation(bot, timing); }
  catch { return failure("BLOCKED", "Station confirmation is unavailable for this Minecraft version."); }
  // A window may be created before its initial contents arrive or openFurnace resolves.
  const captureWindow = () => { owned ??= bot.currentWindow; };
  for (const event of ["end", "death", "respawn"] as const) bot.on(event, lost);
  let result: TaskResult<StationResult> = failure("ACTION_NOT_CONFIRMED", "The station operation was not confirmed.");
  try {
    signal.throwIfAborted();
    const current = bot.blockAt(block.position);
    const access = inspectInteractionAccess(bot, block.position, STATION_LIMITS.interactionReach);
    if (current?.name !== kind || !access.accessible || !access.aim) throw new StationError("WORLD_CHANGED", "The station changed or is no longer accessible.");
    await bot.lookAt(access.aim, true);
    signal.throwIfAborted();
    if (currentWindow()) throw new StationError("BLOCKED", "Another inventory window opened; it was left unchanged.");
    if (bot.blockAt(block.position)?.name !== kind ||
      !inspectInteractionAccess(bot, block.position, STATION_LIMITS.interactionReach).accessible) {
      throw new StationError("WORLD_CHANGED", "The station changed or is no longer accessible.");
    }
    bot._client.on("open_window", captureWindow);
    trace("open");
    const opened = kind === "chest" ? await bot.openContainer(current) : await bot.openFurnace(current);
    owned ??= opened;
    signal.throwIfAborted();
    if (currentWindow() !== opened || owned !== opened) throw new StationError("WORLD_CHANGED", "The station window was replaced.");
    if (kind === "chest" ? opened.inventoryStart !== 27 : opened.inventoryStart !== 3) {
      throw new StationError("BLOCKED", "This station layout is not supported.");
    }
    observation.bind(opened);
    const snapshot = () => {
      signal.throwIfAborted();
      if (currentWindow() !== opened) throw new StationError("WORLD_CHANGED", "The station is no longer open.");
      const state = observation.snapshot();
      if (!state) throw new StationError("ACTION_NOT_CONFIRMED", "Station contents are unknown, not empty.");
      return state;
    };
    const refresh = async () => {
      if (!await observation.synchronize(signal)) throw new StationError("ACTION_NOT_CONFIRMED", "The server did not confirm the station contents.");
      return snapshot();
    };
    const initial = await refresh();
    if (initial.cursor !== null) throw new StationError("BLOCKED", "An item is held by the inventory cursor; it was not moved.");
    const session: StationSession = {
      bot, window: opened, signal, observation, snapshot, refresh, progress,
      expectInventory: items => { expectedInventory = { ...items }; },
      attempt: async (label, work) => {
        signal.throwIfAborted();
        progress({ operation: label, inventoryKnown: false });
        trace(label);
        // Native transfer may reject after making changes. Observe once, never replay it here.
        try { await work(); }
        catch (error) { trace(`${label}.native_error`, { message: errorMessage(error) }); }
        signal.throwIfAborted();
        const state = await refresh();
        progress({ inventoryKnown: true });
        return state;
      },
    };
    result = await action(session);
  } catch (error) {
    trace("error", { message: errorMessage(error) });
    result = failure(context.signal.aborted ? "INTERRUPTED" : error instanceof StationError ? error.code : "ACTION_NOT_CONFIRMED",
      context.signal.aborted ? "The operation stopped; some items may already have moved. Inspect the station and bot inventory before retrying."
        : error instanceof StationError ? error.message : "The station operation could not be confirmed. Inspect its contents before retrying.");
  } finally {
    try {
      const window = owned as Window | null;
      if (window && currentWindow() === window) {
        trace("close");
        // Emits the native close event too, releasing furnace property listeners.
        if (typeof (window as Furnace).close === "function") await (window as Furnace).close();
        else await bot.closeWindow(window);
      }
      const closed = currentWindow() === null;
      progress({ closed });
      if (!closed) result = failure("ACTION_NOT_CONFIRMED", "The station window could not be closed safely; no further operation was started.");
    } catch (error) {
      progress({ closed: false });
      trace("close.error", { message: errorMessage(error) });
      result = failure("ACTION_NOT_CONFIRMED", "Closing the station failed. Items may already have moved.");
    } finally {
      observation.dispose();
      bot._client.removeListener("open_window", captureWindow);
      for (const event of ["end", "death", "respawn"] as const) bot.removeListener(event, lost);
    }
  }
  if (result.ok && expectedInventory && !signal.aborted) {
    const inventory = new ServerInventoryConfirmation(bot, timing);
    try {
      const expected = expectedInventory as Record<string, number>;
      if (!await inventory.synchronize(signal, state => state.cursor === null &&
        Object.entries(expected).every(([item, count]) => (state.items[item] ?? 0) === count))) {
        progress({ inventoryKnown: false });
        result = failure("ACTION_NOT_CONFIRMED", "The station changed, but the bot inventory was not confirmed after closing. Inspect before retrying.");
      }
    } catch {
      progress({ inventoryKnown: false });
      result = failure("ACTION_NOT_CONFIRMED", "The bot inventory could not be confirmed after closing. Inspect before retrying.");
    } finally { inventory.dispose(); }
  }
  if (signal.aborted) result = failure(context.signal.aborted ? "INTERRUPTED" : "WORLD_CHANGED",
    "The operation stopped. Inspect the station and bot inventory before retrying; changes are not rolled back.");
  trace("finished", { ok: result.ok, ...facts });
  return result.ok ? { ok: true, value: { ...result.value, position, closed: true } }
    : { ok: false, error: { ...result.error, facts: { ...facts, ...result.error.facts } } };
}

export function stationInventory(session: StationSession, state = session.snapshot()) {
  return windowTotals(state.slots.slice(session.window.inventoryStart, session.window.inventoryEnd));
}

export async function waitForStation(session: StationSession, check: (state: WindowSnapshot) => boolean, timeoutMs: number): Promise<boolean> {
  return waitForConfirmation(() => check(session.snapshot()), session.signal, { ...ACTION_CONFIRMATION, timeoutMs });
}
