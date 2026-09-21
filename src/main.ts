import "./Logger";
import { resolve } from "node:path";
import { loadAgentConfig } from "./agent/AgentConfig";
import {
  createAgentRuntime,
  type RunningAgentRuntime,
} from "./bootstrap/createAgentRuntime";
import {
  createDemoRuntime,
  type RunningDemoRuntime,
} from "./bootstrap/createDemoRuntime";
import { MINECRAFT_VERSION } from "./config";
import { LandmarkMemory } from "./memory/LandmarkMemory";
import { MinecraftRuntime } from "./runtime/MinecraftRuntime";

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const landmarks =
    config.botMode === "agent"
      ? await LandmarkMemory.load(
          resolve(process.cwd(), config.landmarksFile),
        )
      : null;
  const runtime = new MinecraftRuntime({
    host: process.env.MINECRAFT_HOST ?? "localhost",
    port: readPort(process.env.MINECRAFT_PORT),
    username: process.env.MINECRAFT_USERNAME ?? "bot",
    version: MINECRAFT_VERSION,
    auth: "offline",
  });
  let agentRuntime: RunningAgentRuntime | null = null;
  let demoRuntime: RunningDemoRuntime | null = null;

  try {
    console.info("Connecting to Minecraft...");
    await runtime.connect();
    console.info(`Connected as ${runtime.bot.username}.`);
    if (config.botMode === "agent") {
      agentRuntime = await createAgentRuntime(
        runtime,
        config,
        landmarks ?? undefined,
      );
      console.info(
        `Agent mode ready with model "${config.llmModel}". Waiting for chat.`,
      );
    } else {
      demoRuntime = createDemoRuntime(runtime);
      console.info("Demo mode started.");
    }

    await waitForShutdown(runtime);
  } finally {
    await agentRuntime?.shutdown("Minecraft process stopped.");
    await demoRuntime?.shutdown("Minecraft process stopped.");
    if (!agentRuntime && !demoRuntime) runtime.disconnect();
  }
}

function waitForShutdown(runtime: MinecraftRuntime): Promise<void> {
  console.info("Bot remains connected. Press Ctrl+C to stop.");

  return new Promise((resolve) => {
    let closing = false;

    const finish = (): void => {
      if (closing) return;
      closing = true;
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      runtime.bot.removeListener("end", finish);
      resolve();
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    runtime.bot.once("end", finish);
  });
}

function readPort(value: string | undefined): number {
  if (value === undefined) return 25565;

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid MINECRAFT_PORT "${value}".`);
  }
  return port;
}

void main().catch((error: unknown) => {
  console.error("Executive layer failed to start:", error);
  process.exitCode = 1;
});
