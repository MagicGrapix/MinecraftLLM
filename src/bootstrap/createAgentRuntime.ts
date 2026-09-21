import { resolve } from "node:path";
import type { AgentConfig } from "../agent/AgentConfig";
import { AgentContextBuilder } from "../agent/AgentContextBuilder";
import { AgentToolBridge } from "../agent/AgentToolBridge";
import { Agent } from "../agent/Agent";
import { ChatIntentRouter } from "../chat/ChatIntentRouter";
import { MinecraftChatAdapter } from "../chat/MinecraftChatAdapter";
import { ExecutionController } from "../execution/ExecutionController";
import { Executor } from "../execution/Executor";
import { OpenAICompatibleLLMClient } from "../llm/OpenAICompatibleLLMClient";
import { ConversationHistory } from "../memory/ConversationHistory";
import { LandmarkMemory } from "../memory/LandmarkMemory";
import { RecentActivityBuffer } from "../memory/RecentActivityBuffer";
import { ContainerSessionManager } from "../runtime/ContainerSessionManager";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import { toVec3 } from "../runtime/PositionAdapter";
import { SkillLoader } from "../skills/SkillLoader";
import { SkillRegistry } from "../skills/SkillRegistry";
import { MineflayerWorldQueries } from "../world/MineflayerWorldQueries";
import { createDefaultWorldQueryRegistry } from "../world/queries/defaultQueries";
import { createCapabilityRegistry } from "./createCapabilities";

export interface RunningAgentRuntime {
  readonly agent: Agent;
  readonly controller: ExecutionController;
  readonly chat: MinecraftChatAdapter;
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
  const controller = new ExecutionController({ executor });
  const activities = new RecentActivityBuffer(15);
  const history = new ConversationHistory(6, 16_000);
  const llm = new OpenAICompatibleLLMClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    requestTimeoutMs: config.llmRequestTimeoutMs,
  });
  const bridge = new AgentToolBridge({
    controller,
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
    controller,
    capabilities,
    queries,
    skills,
    landmarks,
    activities,
    history,
    budgetChars: config.llmContextBudgetChars,
  });

  let chat: MinecraftChatAdapter | null = null;
  const agent = new Agent({
    llm,
    intentRouter: new ChatIntentRouter(llm),
    contextBuilder,
    toolBridge: bridge,
    controller,
    history,
    activities,
    maxToolRounds: config.llmMaxToolRounds,
    temperature: config.llmTemperature,
    maxTokens: config.llmMaxTokens,
    turnTimeoutMs: config.llmRequestTimeoutMs,
    respond: async (message) => {
      await chat?.send(message);
    },
  });
  chat = new MinecraftChatAdapter({
    bot: runtime.bot,
    agent,
    ownerUsername: config.botOwnerUsername,
  });

  const unsubscribe = controller.subscribe((event) => {
    agent.notifyExecutionEvent(event);
    if (event.type === "task_finished") {
      void refreshLandmarksFromTask(
        event,
        runtime.bot.game.dimension,
        landmarks,
      );
    }
    if (
      event.type === "queue_changed" &&
      (event.reason === "clear" ||
        (event.reason === "replace" &&
          event.snapshot.pending.length === 0))
    ) {
      void sessions.closeActive("Execution queue abandoned.");
    }
  });

  agent.start();
  chat.attach();
  let shutdownPromise: Promise<void> | null = null;

  return {
    agent,
    controller,
    chat,
    shutdown(reason = "Agent runtime stopped."): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        chat?.detach();
        await agent.shutdown();
        await controller.shutdown(reason);
        await sessions.closeActive(reason);
        await landmarks.persist();
        unsubscribe();
        runtime.disconnect(reason);
      })();
      return shutdownPromise;
    },
  };
}

async function refreshLandmarksFromTask(
  event: Extract<
    import("../execution/ExecutionController").ExecutionEvent,
    { type: "task_finished" }
  >,
  dimension: string,
  landmarks: LandmarkMemory,
): Promise<void> {
  const input = event.task.input;
  if (typeof input !== "object" || input === null) return;
  const candidate =
    "position" in input
      ? input.position
      : "tablePosition" in input
        ? input.tablePosition
        : null;
  if (!isPosition(candidate)) return;

  if (
    !event.result.ok &&
    (event.result.error.code === "TARGET_NOT_FOUND" ||
      event.result.error.code === "WORLD_CHANGED")
  ) {
    await landmarks.markAtPosition(
      dimension,
      candidate,
      "stale",
      false,
    );
    return;
  }
  if (
    event.result.ok &&
    (event.task.capability === "place" ||
      event.task.capability === "use_block" ||
      event.task.capability === "open_container" ||
      event.task.capability === "craft")
  ) {
    await landmarks.markAtPosition(
      dimension,
      candidate,
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
