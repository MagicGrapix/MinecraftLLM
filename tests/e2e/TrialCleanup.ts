import type { AgentProcess } from "./AgentProcess";
import type { TestWorld } from "./TestWorld";
import type { TrialResult } from "./types";
import { message } from "./async";
import { scenarioConfig } from "./config";

/** A trial error is recoverable only after its owned process and server player are gone. */
export async function cleanupTrial(
  world: Pick<TestWorld, "chat" | "waitDisconnected">,
  bot: Pick<AgentProcess, "failure" | "close"> | null,
  result: TrialResult,
  record: (event: string, data: unknown) => void,
): Promise<void> {
  if (bot) {
    // Chat uses the normal stop entry point; IPC confirms settlement/process exit.
    if (!bot.failure) await world.chat("stop").catch((error) => record("stop.chat_error", { error: message(error) }));
    result.forcedShutdown = await bot.close(scenarioConfig.stopGraceMs);
    if (result.forcedShutdown && result.status !== "timeout") {
      result.status = "error";
      result.error ??= "Physical shutdown required terminating the test process.";
    }
  }
  // Also check after a setup error, even when no child was created. This checks
  // controller health and prevents resetting underneath an unexpected test player.
  await world.waitDisconnected();
}
