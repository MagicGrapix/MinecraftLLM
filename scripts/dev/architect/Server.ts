import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArchitectWorkbench, TrialInputSchema } from "./Workbench";

export async function startWorkbenchServer(workbench: ArchitectWorkbench, options: { port?: number; uiRoot?: string } = {}) {
  const uiRoot = options.uiRoot ?? join(__dirname, "ui");
  let origin = "";
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => json(response, 500, { error: String(error) }));
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Loopback alone is not CSRF/DNS-rebinding protection. No CORS and no foreign Host/Origin.
    if (request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)) {
      json(response, 403, { error: "Only same-origin local requests are allowed." }); return;
    }
    const path = new URL(request.url ?? "/", origin).pathname;
    if (request.method === "GET") {
      if (path === "/api/state") { json(response, 200, workbench.state()); return; }
      if (path.startsWith("/api/trials/")) {
        const trial = await workbench.get(path.slice("/api/trials/".length));
        json(response, trial ? 200 : 404, trial ?? { error: "Unknown trial in this server session." }); return;
      }
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"],
      };
      const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
      if (asset) {
        const content = await readFile(join(uiRoot, asset[0]));
        response.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8`, "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        response.end(content); return;
      }
    }
    if (request.method === "POST" && (path === "/api/trials" || path === "/api/stop")) {
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
        json(response, 415, { error: "Use application/json." }); return;
      }
      let raw: unknown;
      try { raw = await readJson(request); }
      catch (error: unknown) { json(response, 400, { error: String(error) }); return; }
      if (path === "/api/stop") { await workbench.stop(); json(response, 200, { stopped: true }); return; }
      const parsed = TrialInputSchema.safeParse(raw);
      if (!parsed.success) { json(response, 400, { error: parsed.error.message }); return; }
      try { json(response, 202, workbench.start(parsed.data)); }
      catch (error: unknown) { json(response, 409, { error: String(error) }); }
      return;
    }
    json(response, 404, { error: "Not found" });
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 3004, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workbench did not bind a TCP port.");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, close: async () => {
    await workbench.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep draining an oversized body, but never retain more than the bound.
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= 65536) chunks.push(Buffer.from(chunk));
  }
  if (bytes > 65536) throw new Error("Request body exceeds 64 KiB.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}
