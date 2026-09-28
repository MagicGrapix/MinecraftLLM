import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadAgentConfig } from "../agent/AgentConfig";
import { defaultLabScenario } from "./LabScenario";
import { startLabServer } from "./LabServer";

async function main(): Promise<void> {
  const rawPort = process.env.LAB_PORT ?? "3002";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid LAB_PORT: ${rawPort}`);
  }
  const uiRoot = [
    join(process.cwd(), "src", "lab", "ui"),
    join(process.cwd(), "dist", "lab", "ui"),
  ].find((path) => existsSync(join(path, "index.html")));
  if (!uiRoot) throw new Error("Prompt lab UI files were not found.");

  const server = await startLabServer(loadAgentConfig(), defaultLabScenario, port, uiRoot);
  console.info(`Prompt lab available at ${server.url}`);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().catch((error: unknown) => console.error(error));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error("Prompt lab failed to start:", error);
  process.exitCode = 1;
});
