import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AgentInspector } from "./AgentInspector";
import { subscribeTrace } from "../TraceLog";

export interface AgentInspectorServerOptions {
  readonly inspector: AgentInspector;
  readonly host: string;
  readonly port: number;
  readonly uiRoot: string;
  readonly getAgentState?: () => unknown;
}

export interface AgentInspectorServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export async function startAgentInspectorServer(
  options: AgentInspectorServerOptions,
): Promise<AgentInspectorServerHandle> {
  if (options.host !== "127.0.0.1") {
    throw new Error(
      `Agent inspector must bind to 127.0.0.1, got "${options.host}".`,
    );
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : options.port;
  const url = `http://${options.host}:${port}`;
  let closed = false;
  const unsubscribe = subscribeTrace((event, data) => options.inspector.collections.record(event, data));

  return {
    url,
    port,
    close: () => { unsubscribe(); return closeServer(server, () => closed, (value) => { closed = value; }); },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AgentInspectorServerOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const hostHeader = request.headers.host ?? `${options.host}:${options.port}`;
  const url = new URL(request.url ?? "/", `http://${hostHeader}`);
  const path = url.pathname;

  if (method === "POST" && path === "/api/rounds/clear") {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${options.host}:${request.socket.localPort}`) {
      sendJson(response, 403, { error: "Invalid origin." });
      return;
    }
    try {
      sendJson(response, 200, {
        cleared: options.inspector.clearRounds(),
        sessionId: options.inspector.sessionId,
      });
    } catch (error: unknown) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD, POST");
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (path === "/api/status") {
    sendJson(response, 200, {
      ...options.inspector.status(),
      ...(options.getAgentState
        ? { agent: options.getAgentState() }
        : {}),
    });
    return;
  }

  if (path === "/api/rounds") {
    sendJson(response, 200, {
      rounds: options.inspector.listRounds(),
    });
    return;
  }

  const roundMatch = /^\/api\/rounds\/([^/]+)$/.exec(path);
  const collectionMatch = /^\/api\/collections\/(\d+)$/.exec(path);
  if (collectionMatch) {
    try {
      const page = options.inspector.collections.page(Number(collectionMatch[1]),
        Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 50));
      sendJson(response, page ? 200 : 404, page ?? { error: "Collection detail unavailable or evicted; see the session JSONL trace." });
    } catch (error) { sendJson(response, 400, { error: String(error) }); }
    return;
  }
  if (roundMatch) {
    const id = decodeURIComponent(roundMatch[1]!);
    const round = options.inspector.getRound(id);
    if (!round) {
      sendJson(response, 404, { error: "Round not found." });
      return;
    }
    sendJson(response, 200, round);
    return;
  }

  if (path === "/" || path === "/index.html") {
    await sendFile(response, join(options.uiRoot, "index.html"), method);
    return;
  }

  if (path === "/inspector.js" || path === "/inspector.css") {
    await sendFile(response, join(options.uiRoot, path.slice(1)), method);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function sendFile(
  response: ServerResponse,
  filePath: string,
  method: string,
): Promise<void> {
  try {
    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function closeServer(
  server: Server,
  isClosed: () => boolean,
  setClosed: (value: boolean) => void,
): Promise<void> {
  if (isClosed()) return Promise.resolve();
  setClosed(true);
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
