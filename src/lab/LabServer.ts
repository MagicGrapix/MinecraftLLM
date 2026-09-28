import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentConfig } from "../agent/AgentConfig";
import type { TaskErrorCode } from "../execution/TaskResult";
import { resolveInspectorUiRoot } from "../debug/resolveInspectorUiRoot";
import { LabScenarioSchema, type LabScenario } from "./LabScenario";
import { LabSession } from "./LabSession";

const MessageSchema = z.object({ text: z.string().trim().min(1).max(2_000) }).strict();
const ResolutionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("success") }).strict(),
  z.object({
    outcome: z.literal("failure"),
    code: z.enum([
      "TARGET_NOT_FOUND", "NO_PATH", "OUT_OF_REACH", "MISSING_ITEM", "RECIPE_NOT_FOUND",
      "NOT_CONSUMABLE", "CONTAINER_NOT_OPEN", "ENTITY_NOT_FOUND", "ACTION_NOT_CONFIRMED",
      "BLOCKED", "TIMEOUT", "WORLD_CHANGED", "INTERRUPTED", "INVALID_ARGUMENT", "INTERNAL_ERROR",
    ]),
    message: z.string().trim().min(1).max(500),
  }).strict(),
]);
const ResetSchema = z.object({ scenario: LabScenarioSchema }).strict();
const maxBodyBytes = 256_000;

export interface LabServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

export async function startLabServer(
  config: AgentConfig,
  initialScenario: LabScenario,
  port: number,
  uiRoot: string,
): Promise<LabServerHandle> {
  let session = await LabSession.create(initialScenario, config);
  let resetting = false;
  const inspectorRoot = resolveInspectorUiRoot();

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;

    if (method === "GET") {
      if (path === "/") return await sendFile(response, join(uiRoot, "index.html"), "text/html; charset=utf-8");
      if (path === "/lab.js") return await sendFile(response, join(uiRoot, "lab.js"), "text/javascript; charset=utf-8");
      if (path === "/lab.css") return await sendFile(response, join(uiRoot, "lab.css"), "text/css; charset=utf-8");
      if (path === "/inspector") return await sendFile(response, join(inspectorRoot, "index.html"), "text/html; charset=utf-8");
      if (path === "/inspector.js") return await sendFile(response, join(inspectorRoot, "inspector.js"), "text/javascript; charset=utf-8");
      if (path === "/inspector.css") return await sendFile(response, join(inspectorRoot, "inspector.css"), "text/css; charset=utf-8");
      if (path === "/api/lab/state") return sendJson(response, 200, session.state());
      if (path === "/api/status") {
        return sendJson(response, 200, { ...session.inspector.status(), agent: session.agent.state() });
      }
      if (path === "/api/rounds") return sendJson(response, 200, { rounds: session.inspector.listRounds() });
      const match = /^\/api\/rounds\/([^/]+)$/.exec(path);
      if (match) {
        const round = session.inspector.getRound(decodeURIComponent(match[1]!));
        return sendJson(response, round ? 200 : 404, round ?? { error: "Round not found." });
      }
      return sendJson(response, 404, { error: "Not found." });
    }

    if (method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });
    const origin = request.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      return sendJson(response, 403, { error: "Invalid origin." });
    }
    if (resetting) return sendJson(response, 409, { error: "Lab reset is in progress." });

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error: unknown) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }

    if (path === "/api/lab/message") {
      const parsed = MessageSchema.safeParse(body);
      if (!parsed.success) return sendJson(response, 400, { error: parsed.error.flatten() });
      if (session.agent.state().mode !== "idle") {
        return sendJson(response, 409, { error: "Agent is busy. Wait for the current run or stop it." });
      }
      session.submitMessage(parsed.data.text);
      return sendJson(response, 202, { accepted: true });
    }
    if (path === "/api/lab/resolve") {
      const parsed = ResolutionSchema.safeParse(body);
      if (!parsed.success) return sendJson(response, 400, { error: parsed.error.flatten() });
      const result = parsed.data.outcome === "success"
        ? session.executor.approve()
        : session.executor.reject(parsed.data.code as TaskErrorCode, parsed.data.message);
      return sendJson(response, result ? 200 : 409, result ?? { error: "No action is waiting." });
    }
    if (path === "/api/lab/stop") {
      await session.agent.requestStop("lab");
      return sendJson(response, 200, { stopped: true });
    }
    if (path === "/api/lab/resume") {
      if (session.agent.state().mode !== "stopped") {
        return sendJson(response, 409, { error: "Agent is not stopped." });
      }
      session.agent.requestResume("lab");
      return sendJson(response, 202, { resumed: true });
    }
    if (path === "/api/lab/reset") {
      const parsed = ResetSchema.safeParse(body);
      if (!parsed.success) return sendJson(response, 400, { error: parsed.error.flatten() });
      resetting = true;
      try {
        const next = await LabSession.create(parsed.data.scenario, config);
        await session.shutdown();
        session = next;
        return sendJson(response, 200, { sessionId: session.inspector.sessionId });
      } finally {
        resetting = false;
      }
    }
    return sendJson(response, 404, { error: "Not found." });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await session.shutdown();
      await closeServer(server);
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function sendFile(response: ServerResponse, path: string, contentType: string): Promise<void> {
  const body = await readFile(path);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
