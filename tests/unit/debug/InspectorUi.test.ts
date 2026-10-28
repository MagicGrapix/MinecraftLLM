import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function harness() {
  const source = await readFile(resolve("src/debug/ui/inspector.js"), "utf8");
  const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
  const elements = new Map<string, ReturnType<typeof element>>();
  function element() {
    return { innerHTML: "", textContent: "", scrollTop: 17, disabled: false, dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {}, querySelectorAll: () => [], appendChild() {} };
  }
  const context = {
    document: { getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }, createElement: element },
    fetch: (path: string) => new Promise((resolve) => { pending.push({ path, resolve }); }),
    setInterval() {}, setTimeout, navigator: {},
    testing: undefined as unknown as {
      state: { selectedId: string | null; selectedSnapshot: unknown; live: boolean; sessionId: string | null; tab: string };
      selectRound(id: string, manual: boolean): Promise<void>;
      refreshList(poll: boolean): Promise<void>;
      setLive(value: boolean): void;
    },
  };
  runInNewContext(source.replace("void bootstrap();", "globalThis.testing = { state, selectRound, refreshList, setLive };"), context);
  function reply(path: string, value: unknown) {
    const index = pending.findIndex((request) => request.path === path);
    assert.ok(index >= 0, "Pending request: " + path);
    pending.splice(index, 1)[0]!.resolve({ ok: true, json: async () => value });
  }
  return { ...context.testing, reply, pending, elements };
}
test("slow old detail responses cannot overwrite a newer manual selection", async () => {
  const h = await harness();
  const old = h.selectRound("old", false);
  const latest = h.selectRound("new", true);
  h.reply("/api/rounds/new", { id: "new", generationId: 2, requestTitle: "New" });
  await latest;
  h.reply("/api/rounds/old", { id: "old", generationId: 1, requestTitle: "Old" });
  await old;
  assert.equal(h.state.selectedId, "new");
  assert.equal(h.state.live, false);
  assert.equal(h.elements.get("detailTitle")!.textContent, "New");
  assert.equal(h.elements.get("detailBody")!.scrollTop, 17);
});

test("inspector labels are English while recorded player and model text stays unchanged", async () => {
  const html = await readFile(resolve("src/debug/ui/index.html"), "utf8");
  assert.match(html, /lang="en"/);
  assert.match(html, /Show latest/);
  assert.match(html, /Requests and calls/);
  assert.match(html, /aria-label="Search calls"/);
  const request = await harness();
  const selected = request.selectRound("french-request", true);
  request.reply("/api/rounds/french-request", { id: "french-request", generationId: 1,
    requestBody: { messages: [{ role: "user", content: "Vérifie mon inventaire." }] } });
  await selected;
  assert.match(request.elements.get("detailBody")!.innerHTML, /Readable request view/);
  assert.match(request.elements.get("detailBody")!.innerHTML, /Vérifie mon inventaire\./);
  const response = await harness(); response.state.tab = "response";
  const reply = response.selectRound("french-reply", true);
  response.reply("/api/rounds/french-reply", { id: "french-reply", generationId: 1,
    response: { content: "J’ai fini.", toolCalls: [] } });
  await reply;
  assert.match(response.elements.get("detailBody")!.innerHTML, /Readable response view/);
  assert.match(response.elements.get("detailBody")!.innerHTML, /J’ai fini\./);
});
test("tool details display the shared action number separately from the native call ID", async () => {
  const h = await harness();
  h.state.tab = "debug";
  const selected = h.selectRound("numbered", true);
  h.reply("/api/rounds/numbered", {
    id: "numbered", phase: "actioner", generationId: 1, requestTitle: "Dig", status: "completed",
    toolExecutions: [{ actionNumber: 12, toolCallId: "call_native", name: "dig", arguments: "{}", result: '{"ok":true,"actionNumber":12}', ok: true }],
  });
  await selected;
  assert.match(h.elements.get("detailBody")!.innerHTML, /Action #12/);
  assert.match(h.elements.get("detailBody")!.innerHTML, /call_native/);
});

test("collection details are lazy and are not fetched while reading the parent result", async () => {
  const h = await harness(); h.state.tab = "debug";
  const selected = h.selectRound("collect", true);
  h.reply("/api/rounds/collect", { id: "collect", phase: "actioner", generationId: 1, status: "completed",
    toolExecutions: [{ actionNumber: 42, toolCallId: "native", name: "collect_resource", arguments: "{}", result: '{"ok":true}', ok: true }] });
  await selected;
  assert.match(h.elements.get("detailBody")!.innerHTML, /data-collection-action="42"/);
  assert.match(h.elements.get("detailBody")!.innerHTML, /no LLM calls/);
  assert.equal(h.pending.length, 0); assert.equal(h.state.live, false);
});

test("pause invalidates pending automatic selection and polling is single-flight", async () => {
  const h = await harness();
  const old = h.selectRound("old", false);
  h.setLive(false);
  h.reply("/api/rounds/old", { id: "old" });
  await old;
  assert.equal(h.state.selectedSnapshot, null);
  h.state.sessionId = "session";
  const first = h.refreshList(true);
  await h.refreshList(true);
  assert.equal(h.pending.length, 1);
  h.reply("/api/status", { sessionId: "session", finalizedCount: 0, maxRounds: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  h.reply("/api/rounds", { rounds: [] });
  await first;
  assert.equal(h.pending.length, 0);
});
