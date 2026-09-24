import { resolve } from "node:path";
import type { AgentConfig } from "../agent/AgentConfig";
import { AgentContextBuilder } from "../agent/AgentContextBuilder";
import { AgentToolBridge } from "../agent/AgentToolBridge";
import { MemoryUpdater } from "../agent/MemoryUpdater";
import { SequentialAgent } from "../agent/SequentialAgent";
import { WorkingMemory } from "../agent/WorkingMemory";
import { ChatIntentRouter } from "../chat/ChatIntentRouter";
import { MinecraftChatAdapter } from "../chat/MinecraftChatAdapter";
import { AgentInspector } from "../debug/AgentInspector";
import {
  startAgentInspectorServer,
  type AgentInspectorServerHandle,
} from "../debug/AgentInspectorServer";
import { resolveInspectorUiRoot } from "../debug/resolveInspectorUiRoot";
import {
  SequentialPlanRunner,
  type SequentialRunnerEvent,
} from "../execution/SequentialPlanRunner";
import { Executor } from "../execution/Executor";
import { OpenAICompatibleLLMClient } from "../llm/OpenAICompatibleLLMClient";
import { LandmarkMemory } from "../memory/LandmarkMemory";
import { loadAgentPrompts } from "../prompts/AgentPrompts";
import { ContainerSessionManager } from "../runtime/ContainerSessionManager";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { toVec3 } from "../runtime/PositionAdapter";
import { SkillLoader } from "../skills/SkillLoader";
import { SkillRegistry } from "../skills/SkillRegistry";
import { MineflayerWorldQueries } from "../world/MineflayerWorldQueries";
import { createDefaultWorldQueryRegistry } from "../world/queries/defaultQueries";
import { createCapabilityRegistry } from "./createCapabilities";

export interface RunningAgentRuntime {
  readonly agent: SequentialAgent;
  readonly runner: SequentialPlanRunner;
  readonly chat: MinecraftChatAdapter;
  readonly inspector: AgentInspector | null;
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
  const queries = createDefaultWorldQueryRegistry(world);
  const skills = await SkillRegistry.discover(
    resolve(process.cwd(), "skills"),
  );
  const skillLoader = new SkillLoader(skills, capabilities, queries);
  const prompts = await loadAgentPrompts(
    resolve(process.cwd(), config.promptsDirectory),
  );
  const landmarks =
    preloadedLandmarks ??
    (await LandmarkMemory.load(
      resolve(process.cwd(), config.landmarksFile),
    ));
  const executor = new Executor({
    registry: capabilities,
    runtime,
    world,
  });
  const runner = new SequentialPlanRunner(executor);
  const workingMemory = new WorkingMemory(config.memoryMaxChars);
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
  const contextBuilder = new AgentContextBuilder({
    world,
    landmarks,
    capabilities,
    systemPrompt: prompts.system,
  });

  let chat: MinecraftChatAdapter | null = null;
  const memoryUpdater = new MemoryUpdater({
    llm,
    prompt: prompts.memoryUpdate,
    memory: workingMemory,
    maxRetries: config.responseMaxRetries,
    maxTokens: config.llmMaxTokens,
    ...(inspector ? { inspector } : {}),
    notifyRetry: async (message) => {
      await chat?.send(message);
    },
  });
  const agent = new SequentialAgent({
    llm,
    intentRouter: new ChatIntentRouter(
      llm,
      prompts.intentClassifier,
    ),
    contextBuilder,
    toolBridge: bridge,
    runner,
    workingMemory,
    memoryUpdater,
    maxToolRounds: config.llmMaxToolRounds,
    maxResponseRetries: config.responseMaxRetries,
    temperature: config.llmTemperature,
    reasoningEffort: config.llmReasoningEffort,
    maxTokens: config.llmMaxTokens,
    ...(inspector ? { inspector } : {}),
    respond: async (message) => {
      await chat?.send(message);
    },
  });
  chat = new MinecraftChatAdapter({
    bot: runtime.bot,
    agent,
    ownerUsername: config.botOwnerUsername,
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

  const landmarkRefreshes = new Set<Promise<void>>();
  const unsubscribe = runner.subscribe((event) => {
    if (event.type !== "task_finished") return;
    const refresh = refreshLandmarksFromTask(
      event,
      runtime.bot.game.dimension,
      landmarks,
    ).catch((error: unknown) => {
      console.error("Landmark refresh failed:", error);
    });
    landmarkRefreshes.add(refresh);
    void refresh.finally(() => landmarkRefreshes.delete(refresh));
  });

  chat.attach();
  let shutdownPromise: Promise<void> | null = null;

  return {
    agent,
    runner,
    chat,
    inspector,
    shutdown(reason = "Agent runtime stopped."): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        chat?.detach();
        await agent.shutdown();
        await runner.shutdown(reason);
        unsubscribe();
        await Promise.all([...landmarkRefreshes]);
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
  event: Extract<SequentialRunnerEvent, { type: "task_finished" }>,
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
