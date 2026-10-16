import type { MinecraftRuntime } from "./MinecraftRuntime";
import type { Executor } from "../execution/Executor";
import type { InventoryEvidenceReader } from "../agent/StepCheckEvaluator";
import { ServerInventoryConfirmation } from "./ServerInventoryConfirmation";
import type { ConfirmationTiming } from "./waitForConfirmation";

/** A fresh, bounded inbound snapshot; never falls back to local predicted/empty inventory. */
export function createInventoryEvidenceReader(runtime: MinecraftRuntime, executor: Pick<Executor, "currentTask">, timing?: ConfirmationTiming): InventoryEvidenceReader & { dispose(): void } {
  const bot = runtime.bot;
  let ready = runtime.isConnected;
  const invalidate = () => { ready = false; };
  const spawn = () => { ready = true; };
  bot.on("death", invalidate);
  bot.on("respawn", invalidate);
  bot.on("end", invalidate);
  bot.on("spawn", spawn);
  const read: InventoryEvidenceReader = async signal => {
    signal.throwIfAborted();
    const unavailable = (reason: string, message: string) => ({ known: false as const, reason, message });
    const precondition = () => {
      if (!runtime.isConnected) return unavailable("DISCONNECTED", "Bot is not connected.");
      if (!ready || !runtime.bot.entity || !Number.isFinite(runtime.bot.health) || runtime.bot.health <= 0) return unavailable("PLAYER_UNAVAILABLE", "Player state is not valid; wait for spawn.");
      if (executor.currentTask) return unavailable("ACTION_IN_PROGRESS", "A physical operation is still running or settling.");
      if (runtime.bot.currentWindow) return unavailable("CONTAINER_OPEN", "Close the container explicitly before evaluating inventory.");
      return null;
    };
    const blocked = precondition();
    if (blocked) return blocked;
    let confirmation: ServerInventoryConfirmation | undefined;
    try {
      confirmation = new ServerInventoryConfirmation(runtime.bot, timing);
      if (!await confirmation.synchronize(signal)) return unavailable("OBSERVATION_TIMEOUT", "Server inventory was not confirmed within the deadline.");
      signal.throwIfAborted();
      const changed = precondition();
      if (changed) return changed;
      const snapshot = confirmation.snapshot;
      return snapshot ? { known: true, items: snapshot.items } : unavailable("OBSERVATION_UNAVAILABLE", "Player state changed during confirmation.");
    } catch (error) {
      signal.throwIfAborted();
      return unavailable("OBSERVATION_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    } finally { confirmation?.dispose(); }
  };
  return Object.assign(read, { dispose() {
    ready = false;
    bot.removeListener("death", invalidate);
    bot.removeListener("respawn", invalidate);
    bot.removeListener("end", invalidate);
    bot.removeListener("spawn", spawn);
  } });
}
