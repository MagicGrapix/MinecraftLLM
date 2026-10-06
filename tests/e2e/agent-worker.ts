import "../../src/Logger";
import { loadAgentConfig } from "../../src/agent/AgentConfig";
import { createAgentRuntime } from "../../src/bootstrap/createAgentRuntime";
import { snapshotInventory } from "../../src/runtime/InventoryAdapter";
import { MinecraftRuntime, type MinecraftRuntimeOptions } from "../../src/runtime/MinecraftRuntime";
import { SESSION_ID, subscribeTrace } from "../../src/TraceLog";
import type { Position } from "../../src/shared/types";
import { message } from "./async";
import { observeBlocks } from "./BlockObservations";
import type { FixedBuildSpec, Observation, WorkerCommand, WorkerEvent, WorkerReply } from "./types";
import { fixedBuildTrial } from "./FixedBuildTrial";
import { workflowTrialRuntime, type TrialRuntime } from "./TrialRuntime";

interface Options extends MinecraftRuntimeOptions { controllerUsername: string; promptsDirectory: string; landmarksFile: string; blueprintsDirectory: string; fixedBuild?: FixedBuildSpec }
const options = JSON.parse(process.argv[2] ?? "{}") as Options;
const runtime = new MinecraftRuntime(options);
let agentRuntime: TrialRuntime | null = null;
let armed = false;
let expectedPrompt = "";
let closing = false;
let closePromise: Promise<void> | null = null;
let settlePromise: Promise<void> | null = null;
function send(value: WorkerEvent | WorkerReply): void {
  if (process.connected) process.send?.(value, () => undefined);
}
function event(name: string, data: unknown): void { send({ type: "event", event: name, data }); }

subscribeTrace((name, data) => {
  if (name === "workflow.accepted") {
    const input = data as { username: string; text: string };
    if (!armed || input.username !== options.controllerUsername || input.text !== expectedPrompt) {
      event("failure", { error: "Unexpected player input contaminated this isolated trial." });
    } else { event("accepted", data); }
  }
  if (name === "workflow.finished") event("finished", data);
});

function snapshot(positions: readonly Position[] = []): Observation {
  if (!agentRuntime || !runtime.isConnected) throw new Error("Bot is not connected and ready.");
  const bot = runtime.bot;
  const state = agentRuntime.state();
  return {
    inventory: snapshotInventory(bot), position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    blocks: observeBlocks(bot, positions),
    yaw: bot.entity.yaw, pitch: bot.entity.pitch, health: bot.health, food: bot.food,
    effects: Object.keys(bot.entity.effects).length, onGround: bot.entity.onGround,
    physicalIdle: agentRuntime.isPhysicallyIdle(), mode: state.mode,
    windowOpen: !!bot.currentWindow,
    planSteps: state.planSteps, completedSteps: state.completedSteps,
  };
}

function settle(graceMs: number): Promise<void> {
  if (settlePromise) return settlePromise;
  closing = true;
  settlePromise = (async () => {
    if (agentRuntime) {
      agentRuntime.detach();
      await agentRuntime.settle(graceMs);
      event("settled", snapshot());
    }
  })();
  return settlePromise;
}

function shutdown(graceMs: number): Promise<void> {
  if (closePromise) return closePromise;
  closing = true;
  closePromise = (async () => {
    await settle(graceMs);
    if (agentRuntime) await agentRuntime.shutdown();
    else runtime.disconnect();
  })();
  return closePromise;
}

process.on("message", (input: WorkerCommand) => {
  void (async () => {
    try {
      if (!Number.isSafeInteger(input.id)) throw new Error("Invalid IPC request.");
      let value: unknown;
      if (input.command === "snapshot") value = snapshot(input.positions);
      else if (input.command === "arm") {
        if (!agentRuntime || closing || armed || !input.text?.trim()) throw new Error("Cannot arm trial.");
        expectedPrompt = input.text.trim();
        armed = true;
        agentRuntime.attach(expectedPrompt);
      } else if (input.command === "settle") {
        await settle(input.graceMs ?? 10_000);
      } else if (input.command === "shutdown") await shutdown(input.graceMs ?? 10_000);
      else throw new Error("Unknown worker command.");
      send({ type: "reply", id: input.id, value });
      if (input.command === "shutdown") process.disconnect?.();
    } catch (error) { send({ type: "reply", id: input.id, error: message(error) }); }
  })();
});

async function main(): Promise<void> {
  if (!process.send) throw new Error("The scenario worker must be launched by test:scenarios.");
  await runtime.connect();
  runtime.bot.setQuickBarSlot(0);
  runtime.bot.on("error", (error) => event("failure", { error: message(error) }));
  runtime.bot.on("kicked", (reason) => { if (!closing) event("failure", { error: `Kicked: ${JSON.stringify(reason)}` }); });
  runtime.bot.on("end", () => { if (!closing) { event("failure", { error: "Minecraft connection ended." }); void shutdown(5_000).catch(() => undefined); } });
  const config = loadAgentConfig();
  agentRuntime = options.fixedBuild ? await fixedBuildTrial(runtime, options.fixedBuild, options.blueprintsDirectory, options.controllerUsername)
    : workflowTrialRuntime(await createAgentRuntime(runtime, {
    ...config, botMode: "agent", inspectorEnabled: false,
    promptsDirectory: options.promptsDirectory, landmarksFile: options.landmarksFile,
  }, undefined, { blueprintsDirectory: options.blueprintsDirectory }));
  // Preparation cannot accidentally become a user request. Arming restores normal chat handling.
  agentRuntime.detach();
  event("ready", { sessionId: SESSION_ID });
}

process.on("disconnect", () => {
  const timer = setTimeout(() => process.exit(1), 12_000);
  void shutdown(10_000).then(() => { clearTimeout(timer); process.exit(0); }, () => { clearTimeout(timer); process.exit(1); });
});
void main().catch((error) => { event("failure", { error: message(error) }); runtime.disconnect(); process.exitCode = 1; process.disconnect?.(); });
