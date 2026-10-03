import { resolve } from "node:path";
import type { AgentConfig } from "../agent/AgentConfig";
import { ActionContextBuilder } from "../agent/ActionContextBuilder";
import { AgentToolBridge } from "../agent/AgentToolBridge";
import { ActionAgent } from "../agent/ActionAgent";
import type { ActionTaskOutcome } from "../agent/ActionTypes";
import { WorkflowAgent } from "../agent/WorkflowAgent";
import { WorkflowSummaryFile } from "../agent/WorkflowState";
import { SESSION_ID } from "../TraceLog";
import { MinecraftChatAdapter } from "../chat/MinecraftChatAdapter";
import { TOOL_REPLAY_MODE } from "../config";
import { AgentInspector } from "../debug/AgentInspector";
import {
  startAgentInspectorServer,
  type AgentInspectorServerHandle,
} from "../debug/AgentInspectorServer";
import { resolveInspectorUiRoot } from "../debug/resolveInspectorUiRoot";
import { Executor } from "../execution/Executor";
import { ToolCallJournal } from "../execution/ToolCallJournal";
import { snapshotInventory } from "../runtime/InventoryAdapter";
import { OpenAICompatibleLLMClient } from "../llm/OpenAICompatibleLLMClient";
import { LandmarkMemory } from "../memory/LandmarkMemory";
import { loadWorkflowPrompts } from "../prompts/WorkflowPrompts";
import { ContainerSessionManager } from "../runtime/ContainerSessionManager";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { toVec3 } from "../runtime/PositionAdapter";
import { SkillLoader } from "../skills/SkillLoader";
import { SkillRegistry } from "../skills/SkillRegistry";
import { MineflayerWorldQueries } from "../world/MineflayerWorldQueries";
import { createDefaultWorldQueryRegistry } from "../world/queries/defaultQueries";
import { createCapabilityRegistry } from "./createCapabilities";

export interface RunningAgentRuntime {
  readonly agent: WorkflowAgent;
  readonly chat: MinecraftChatAdapter;
  readonly inspector: AgentInspector | null;
  isPhysicallyIdle(): boolean;
  waitForPhysicalIdle(timeoutMs: number): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}

export async function createAgentRuntime(
  runtime: MinecraftRuntime,
  config: AgentConfig,
  preloadedLandmarks?: LandmarkMemory,
): Promise<RunningAgentRuntime> {
  const world = new MineflayerWorldQueries(runtime);
  const sessions = new ContainerSessionManager(runtime.bot);
  const capabilities = createCapabilityRegistry(sessions);
  const executor = new Executor({ registry: capabilities, runtime, world });
  const journal = new ToolCallJournal(() =>
    runtime.isConnected && !executor.currentTask ? snapshotInventory(runtime.bot) : null);
  const queries = createDefaultWorldQueryRegistry(world, journal);
  const skills = await SkillRegistry.discover(
    resolve(process.cwd(), "skills"),
  );
  const skillLoader = new SkillLoader(skills, capabilities, queries);
  const prompts = await loadWorkflowPrompts(
    resolve(process.cwd(), config.promptsDirectory),
  );
  const landmarks =
    preloadedLandmarks ??
    (await LandmarkMemory.load(
      resolve(process.cwd(), config.landmarksFile),
    ));
  const inspector = config.inspectorEnabled
    ? new AgentInspector(config.inspectorMaxRounds)
    : null;
  let inspectorServer: AgentInspectorServerHandle | null = null;
  const llm = new OpenAICompatibleLLMClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    requestTimeoutMs: config.llmRequestTimeoutMs,
    ...(inspector ? { inspector } : {}),
  });
  const bridge = new AgentToolBridge({
    capabilities,
    queries,
    skills,
    skillLoader,
    landmarks,
    currentDimension: () => runtime.bot.game.dimension,
    isPositionLoaded: (position) =>
      runtime.bot.world.getColumnAt(toVec3(position)) !== undefined,
  });
  const contextBuilder = new ActionContextBuilder({
    world,
    landmarks,
    systemPrompt: prompts.actioner,
    conversationSummaryPrompt: prompts.conversationSummary,
  });

  let chat: MinecraftChatAdapter | null = null;
  const actionAgent = new ActionAgent({
    llm,
    contextBuilder,
    toolBridge: bridge,
    executor,
    journal,
    maxResponseRetries: config.responseMaxRetries,
    temperature: config.llmTemperature,
    reasoningEffort: config.llmReasoningEffort,
    maxTokens: config.llmMaxTokens,
    contextSummaryPrompt: prompts.contextSummary,
    toolReplayMode: TOOL_REPLAY_MODE,
    ...(inspector ? { inspector } : {}),
    onRetry: async (message) => { console.warn("Action agent:", message); },
    onTaskFinished: async (outcome) => {
      await refreshLandmarksFromTask(outcome, runtime.bot.game.dimension, landmarks);
    },
  });
  const summaryFile = new WorkflowSummaryFile(SESSION_ID, resolve(process.cwd(), process.env.LOG_DIR ?? "logs"));
  const agent = new WorkflowAgent({
    llm,
    actionAgent,
    journal,
    queries,
    world,
    landmarks,
    prompts,
    ...(inspector ? { inspector } : {}),
    temperature: config.llmTemperature,
    reasoningEffort: config.llmReasoningEffort,
    maxTokens: config.llmMaxTokens,
    maxRetries: config.responseMaxRetries,
    toolReplayMode: TOOL_REPLAY_MODE,
    summaryMaxChars: config.memoryMaxChars,
    summaryFile,
    respond: async (message) => { await chat?.send(message); },
  });
  console.info("Agent workflow summary file.", { path: summaryFile.path });
  console.info("Agent tool replay mode.", { mode: TOOL_REPLAY_MODE });
  chat = new MinecraftChatAdapter({
    bot: runtime.bot,
    agent,
  });

  if (inspector) {
    try {
      inspectorServer = await startAgentInspectorServer({
        inspector,
        host: config.inspectorHost,
        port: config.inspectorPort,
        uiRoot: resolveInspectorUiRoot(),
        getAgentState: () => agent.state(),
      });
      console.info(`Agent inspector available at ${inspectorServer.url}`);
    } catch (error: unknown) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : null;
      if (code === "EADDRINUSE") {
        console.warn(
          `Agent inspector port ${config.inspectorPort} is already in use; continuing without the inspector server.`,
        );
      } else {
        console.warn(
          "Agent inspector failed to start; continuing without it.",
          error,
        );
      }
    }
  }

  chat.attach();
  let shutdownPromise: Promise<void> | null = null;

  return {
    agent,
    chat,
    inspector,
    isPhysicallyIdle: () => executor.currentTask === null,
    waitForPhysicalIdle: (timeoutMs) => executor.waitForIdle(timeoutMs),
    shutdown(reason = "Agent runtime stopped."): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        chat?.detach();
        await agent.shutdown();
        await sessions.closeActive(reason);
        await landmarks.persist();
        if (inspectorServer) {
          try {
            await inspectorServer.close();
          } catch (error: unknown) {
            console.warn("Agent inspector shutdown failed:", error);
          }
          inspectorServer = null;
        }
        runtime.disconnect(reason);
      })();
      return shutdownPromise;
    },
  };
}

export async function refreshLandmarksFromTask(
  event: ActionTaskOutcome,
  dimension: string,
  landmarks: LandmarkMemory,
): Promise<void> {
  const input = event.task.input;
  if (typeof input !== "object" || input === null) return;
  const inputPosition =
    "position" in input
      ? input.position
      : "tablePosition" in input
        ? input.tablePosition
        : "referencePosition" in input
          ? input.referencePosition
          : null;

  if (
    !event.result.ok &&
    (event.result.error.code === "TARGET_NOT_FOUND" ||
      event.result.error.code === "WORLD_CHANGED")
  ) {
    if (!isPosition(inputPosition)) return;
    await landmarks.markAtPosition(
      dimension,
      inputPosition,
      "stale",
      false,
    );
    return;
  }
  if (!event.result.ok) return;

  if (event.task.capability === "dig" && isPosition(inputPosition)) {
    await landmarks.markAtPosition(
      dimension,
      inputPosition,
      "missing",
      true,
    );
    return;
  }
  if (event.task.capability === "place") {
    const placedPosition =
      typeof event.result.value === "object" &&
      event.result.value !== null &&
      "position" in event.result.value
        ? event.result.value.position
        : null;
    if (isPosition(placedPosition)) {
      await landmarks.markAtPosition(
        dimension,
        placedPosition,
        "confirmed",
        true,
      );
    }
    return;
  }
  if (
    isPosition(inputPosition) &&
    (event.task.capability === "use_block" ||
      event.task.capability === "open_container" ||
      event.task.capability === "craft")
  ) {
    await landmarks.markAtPosition(
      dimension,
      inputPosition,
      "confirmed",
      true,
    );
  }
}

function isPosition(
  value: unknown,
): value is { x: number; y: number; z: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number" &&
    typeof (value as { z?: unknown }).z === "number"
  );
}
