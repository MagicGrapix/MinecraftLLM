import { BuildCapability } from "../../src/capabilities/Build";
import { CapabilityRegistry } from "../../src/capabilities/CapabilityRegistry";
import { BlueprintStore } from "../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../src/building/BlueprintValidator";
import { Executor } from "../../src/execution/Executor";
import { TaskFactory } from "../../src/execution/TaskFactory";
import { ToolCallJournal } from "../../src/execution/ToolCallJournal";
import { snapshotInventory } from "../../src/runtime/InventoryAdapter";
import type { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import { writeTrace } from "../../src/TraceLog";
import { MaterialCatalog } from "../../src/world/MaterialCatalog";
import { MineflayerWorldQueries } from "../../src/world/MineflayerWorldQueries";
import { bounded, message } from "./async";
import type { FixedBuildSpec } from "./types";
import type { TrialRuntime } from "./TrialRuntime";

/** Real survival capability, no LLM client/agent. Only the armed chat message starts it. */
export async function fixedBuildTrial(runtime: MinecraftRuntime, spec: FixedBuildSpec, directory: string,
  controller: string): Promise<TrialRuntime> {
  const store = new BlueprintStore(new BlueprintValidator(new MaterialCatalog(runtime.bot.registry)), { directory });
  const saved = await store.save(spec.blueprint);
  if (!saved.ok) throw new Error(`Fixed blueprint invalid: ${JSON.stringify(saved.error)}`);
  const registry = new CapabilityRegistry(); registry.register(new BuildCapability(directory)); registry.freeze();
  const executor = new Executor({ registry, runtime, world: new MineflayerWorldQueries(runtime) });
  const journal = new ToolCallJournal(() => runtime.isConnected && !executor.currentTask ? snapshotInventory(runtime.bot) : null);
  let expected = "", mode = "idle", completed = false, started = false, closing = false;
  let pending: Promise<void> | undefined;
  const detach = () => runtime.bot.off("chat", chat);
  const chat = (username: string, text: string) => {
    if (closing || username === runtime.bot.username) return;
    if (text === "stop") { executor.abortCurrent("Stopped by controller."); return; }
    if (started) return;
    if (username !== controller || text !== expected) {
      writeTrace("workflow.accepted", { username, text, runner: "fixed_build", generationId: 1 });
      return; // The worker marks contamination; no build from an unexpected message.
    }
    started = true; mode = "executing";
    writeTrace("workflow.accepted", { username, text, runner: "fixed_build", generationId: 1 });
    const input = { blueprintId: saved.value.id, origin: spec.origin };
    const task = new TaskFactory().create({ capability: "build", input });
    const actionNumber = journal.start("build", true, { agent: "builder", generationId: 1, toolCallId: task.id, arguments: JSON.stringify(input) });
    pending = (async () => {
      try {
        const result = await executor.execute(task);
        journal.complete(actionNumber, result.ok, JSON.stringify(result));
        completed = result.ok;
        writeTrace("workflow.finished", { generationId: 1, runner: "fixed_build",
          ...(result.ok ? {} : { error: JSON.stringify(result.error) }) });
      } catch (error) {
        journal.complete(actionNumber, false, JSON.stringify({ error: message(error) }));
        writeTrace("workflow.finished", { generationId: 1, error: message(error), runner: "fixed_build" });
      } finally { mode = "idle"; }
    })();
  };
  return {
    state: () => ({ mode, planSteps: started ? 1 : 0, completedSteps: completed ? 1 : 0 }),
    isPhysicallyIdle: () => executor.currentTask === null,
    attach: prompt => { expected = prompt; runtime.bot.on("chat", chat); }, detach,
    settle: async graceMs => {
      closing = true; detach(); executor.abortCurrent("Scenario settlement.");
      await bounded((async () => { await pending; await executor.waitForIdle(graceMs); })(), graceMs, "Settle fixed build");
    },
    shutdown: async () => { closing = true; detach(); runtime.disconnect("Fixed build trial finished."); },
  };
}
