import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import minecraftData from "minecraft-data";
import { ArchitectAgent, type ArchitectOptions } from "../../../src/agent/ArchitectAgent";
import { ArchitectTools } from "../../../src/agent/ArchitectTools";
import { BlueprintStore } from "../../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { ARCHITECT_LIMITS } from "../../../src/building/BuildingConfig";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { failure, type TaskResult } from "../../../src/execution/TaskResult";
import { estimateInputTokens } from "../../../src/llm/InputBudget";
import type { LLMClient, LLMRequest, LLMResponse } from "../../../src/llm/LLMClient";
import { LLMError } from "../../../src/llm/LLMError";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import { blueprintFixture } from "../../support/blueprints";
import { FakeLLMClient } from "../../support/FakeLLMClient";

const catalog = new MaterialCatalog(minecraftData("1.21.11"));
const delegation = { userRequest: "Design a small oak house.", instruction: "Prepare a blueprint only; no construction." };
const textResponse = (content: string): LLMResponse => ({ message: { role: "assistant", content }, finishReason: "stop" });
function tool(name: string, args: unknown): LLMResponse {
  return { message: { role: "assistant", content: null, toolCalls: [{ id: "call_1", name, arguments: JSON.stringify(args) }] }, finishReason: "tool_calls" };
}
function value<T>(result: TaskResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}
function error(result: TaskResult<unknown>) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("Expected failure");
  return result.error;
}

async function setup(t: TestContext, overrides: Partial<ArchitectOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "minecraft-architect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BlueprintStore(new BlueprintValidator(catalog), { directory: join(root, "blueprints") });
  const llm = new FakeLLMClient();
  const inspector = new AgentInspector();
  const tools = new ArchitectTools(catalog, store);
  const agent = new ArchitectAgent({ llm, tools, inspector,
    prompt: await PromptTemplate.load(resolve("prompts/architect.md")),
    contextSummaryPrompt: await PromptTemplate.load(resolve("prompts/context-summary.md")),
    ...overrides,
  });
  return { root, store, llm, inspector, tools, agent };
}

test("Architect advertises only two offline tools and hands off persisted metadata without the grid", async t => {
  const { agent, llm, store, inspector } = await setup(t);
  llm.enqueue(tool("submit_blueprint", await blueprintFixture(true)));
  const report = value(await agent.run({ ...delegation, constraints: ["5 by 5"], observations: "Flat grass, empty inventory." }));
  const saved = value(await store.load(report.blueprintId));
  assert.deepEqual(report.materials, saved.materials);
  assert.deepEqual(report.dimensions, { width: 5, depth: 5, height: 4 });
  assert.equal(report.minecraftVersion, "1.21.11");
  assert.equal(report.formatVersion, 1);
  assert.equal("layers" in report, false);
  assert.equal("blueprint" in report, false);
  assert.equal(llm.requests.length, 1); // No extra finish or summary call on success.
  const request = llm.requests[0]!;
  assert.deepEqual(request.tools!.map(t => t.name), ["lookup_material", "submit_blueprint"]);
  const schema = request.tools![1]!.parameters;
  assert.equal(schema.type, "object");
  assert.ok((schema.required as string[]).includes("layers"));
  assert.match(request.messages[0]!.content!, /5 by 5/);
  assert.match(request.messages[0]!.content!, /Flat grass, empty inventory/);
  assert.doesNotMatch(request.messages[0]!.content!, /\{\{\w+\}\}/);
  assert.equal(inspector.status().inProgressCount, 0);
  assert.equal(inspector.listRounds()[0]!.agentLabel, "Architect");
});

test("invalid shape publishes nothing, then the same conversation repairs the full blueprint", async t => {
  const { agent, llm, root, store, inspector } = await setup(t);
  const drawing = await blueprintFixture();
  const invalid = structuredClone(drawing);
  invalid.layers[0]![0] = "AA";
  llm.enqueue(tool("submit_blueprint", invalid));
  llm.enqueue(async request => {
    assert.deepEqual(await readdir(root), []);
    const last = request.messages.at(-1)!;
    assert.equal(last.role, "tool");
    const feedback = JSON.parse(last.content!);
    assert.equal(feedback.ok, false);
    assert.equal(feedback.error.facts.reason, "INVALID_BLUEPRINT");
    assert.match(JSON.stringify(feedback), /layers/);
    return tool("submit_blueprint", drawing);
  });
  value(await agent.run(delegation));
  assert.equal((await readdir(store.directory)).length, 1);
  assert.equal(inspector.listRounds()[0]!.failed, true);
  assert.equal(inspector.listRounds()[1]!.failed, false);
});

test("unknown material yields suggestions, a lookup, then an explicitly corrected submission", async t => {
  const { agent, llm } = await setup(t);
  const drawing = await blueprintFixture();
  const invalid = structuredClone(drawing);
  invalid.palette.A = "oak_plate";
  llm.enqueue(tool("submit_blueprint", invalid));
  llm.enqueue(request => {
    assert.match(request.messages.at(-1)!.content!, /UNKNOWN_BLOCK/);
    assert.match(request.messages.at(-1)!.content!, /oak_planks/);
    return tool("lookup_material", { query: "oak_plate" });
  });
  llm.enqueue(request => {
    const result = JSON.parse(request.messages.at(-1)!.content!);
    assert.equal(result.value.exact, null);
    assert.ok(result.value.suggestions.some((item: { name: string }) => item.name === "oak_planks"));
    return tool("submit_blueprint", drawing);
  });
  value(await agent.run(delegation));
  assert.equal(llm.requests.length, 3);
});

test("eight calls include validation failures and return a bounded failure, not an accepted design", async t => {
  const { agent, llm, root, inspector } = await setup(t);
  for (let i = 0; i < ARCHITECT_LIMITS.maxCalls; i++) llm.enqueue(tool("submit_blueprint", {}));
  assert.equal(error(await agent.run(delegation)).facts?.reason, "ARCHITECT_CALL_LIMIT");
  assert.equal(llm.requests.length, 8);
  assert.deepEqual(await readdir(root), []);
  assert.equal(inspector.listRounds().at(-1)!.status, "tool_round_limit");
});

test("truncated submission is discarded even if its JSON happens to be valid", async t => {
  const { agent, llm, root, inspector } = await setup(t);
  llm.enqueue({ ...tool("submit_blueprint", await blueprintFixture()), finishReason: "length" });
  assert.equal(error(await agent.run(delegation)).facts?.reason, "TRUNCATED_RESPONSE");
  assert.equal(llm.requests.length, 1);
  assert.deepEqual(await readdir(root), []);
  assert.equal(inspector.listRounds()[0]!.status, "token_limit_discarded");
});

test("text and parallel tool responses execute nothing and receive format feedback", async t => {
  const { agent, llm, root } = await setup(t);
  const drawing = await blueprintFixture();
  llm.enqueue(textResponse("I have finished the house."));
  llm.enqueue(request => {
    assert.match(request.messages[0]!.content!, /exactly one native tool call/);
    const response = tool("submit_blueprint", drawing);
    return { ...response, message: { ...response.message, toolCalls: [...response.message.toolCalls!, { id: "second", name: "submit_blueprint", arguments: JSON.stringify(drawing) }] } };
  });
  llm.enqueue(async request => {
    assert.deepEqual(await readdir(root), []);
    assert.equal(request.messages.some(m => m.role === "tool"), false); // No orphan exchanges.
    return tool("submit_blueprint", drawing);
  });
  value(await agent.run(delegation));
});

test("malformed arguments and forbidden tools are structured feedback, never physical execution", async t => {
  const { agent, llm, root } = await setup(t, { maxCalls: 2 });
  llm.enqueue({ message: { role: "assistant", content: null, toolCalls: [{ id: "bad", name: "submit_blueprint", arguments: "{not-json" }] }, finishReason: "tool_calls" });
  llm.enqueue(request => {
    assert.match(request.messages.at(-1)!.content!, /INVALID_TOOL_ARGUMENTS/);
    return tool("build", { blueprintId: "invented" });
  });
  assert.equal(error(await agent.run(delegation)).facts?.reason, "ARCHITECT_CALL_LIMIT");
  assert.deepEqual(await readdir(root), []);
});

test("a failed store stops immediately instead of asking the model to repair filesystem errors", async t => {
  let saves = 0;
  const failureResult = failure("INTERNAL_ERROR", "Read-only directory", { facts: { reason: "BLUEPRINT_IO_ERROR" } });
  const { agent, llm } = await setup(t, { tools: new ArchitectTools(catalog, { save: async () => { saves++; return failureResult; } }) });
  llm.enqueue(tool("submit_blueprint", await blueprintFixture()));
  assert.deepEqual(await agent.run(delegation), failureResult);
  assert.equal(saves, 1);
  assert.equal(llm.requests.length, 1);
});

test("stop waits for a non-abortable LLM, refuses concurrent work, and discards its late submission", async t => {
  const { agent, llm, root, inspector } = await setup(t);
  const deferred = llm.enqueueDeferred({ ignoreAbort: true });
  const pending = agent.run(delegation);
  await tickUntil(() => llm.requests.length > 0);
  let stopped = false;
  const stop = agent.requestStop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(error(await agent.run(delegation)).code, "BLOCKED");
  deferred.resolve(tool("submit_blueprint", await blueprintFixture()));
  assert.equal(error(await pending).code, "INTERRUPTED");
  await stop;
  assert.deepEqual(await readdir(root), []);
  assert.equal(inspector.status().inProgressCount, 0);
});

test("stop during save waits for publication and reports the saved reference without accepting it", async t => {
  const base = await setup(t);
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { agent, llm } = await setup(t, { tools: new ArchitectTools(catalog, {
    save: async args => { entered = true; await gate; return base.store.save(args); },
  }) });
  llm.enqueue(tool("submit_blueprint", await blueprintFixture()));
  const pending = agent.run(delegation);
  await tickUntil(() => entered);
  let stopped = false;
  const stop = agent.requestStop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(error(await agent.run(delegation)).code, "BLOCKED");
  release();
  const issue = error(await pending);
  assert.equal(issue.code, "INTERRUPTED");
  const id = issue.facts?.savedBlueprintId;
  assert.equal(typeof id, "string");
  value(await base.store.load(id as string));
  await stop;
});

test("a pre-aborted delegation calls neither the LLM nor tools", async t => {
  const { agent, llm } = await setup(t);
  assert.equal(error(await agent.run(delegation, { signal: AbortSignal.abort() })).code, "INTERRUPTED");
  assert.equal(llm.requests.length, 0);
});

test("fresh delegation does not inherit earlier tool calls or private summary", async t => {
  const { agent, llm } = await setup(t);
  llm.enqueue(tool("lookup_material", { query: "dirt" }));
  llm.enqueue(tool("submit_blueprint", await blueprintFixture()));
  value(await agent.run({ ...delegation, userRequest: "Previous secret request" }));
  llm.enqueue(tool("submit_blueprint", await blueprintFixture()));
  value(await agent.run(delegation));
  const request = llm.requests.at(-1)!;
  assert.equal(request.messages.length, 3);
  assert.match(request.messages[1]!.content!, /summary: empty/);
  assert.doesNotMatch(JSON.stringify(request.messages), /Previous secret request/);
});

test("20k protected input is refused before the LLM and is not silently truncated", async t => {
  const { agent, llm } = await setup(t);
  const issue = error(await agent.run({ ...delegation, userRequest: "x".repeat(70_000) }));
  assert.match(issue.message, /protected input/i);
  assert.equal(llm.requests.length, 0);
});

test("older conversation is compacted under 20k while the active request stays chronological", async t => {
  const requests: LLMRequest[] = [];
  const drawing = await blueprintFixture();
  const llm: LLMClient = { complete: async request => {
    requests.push(request);
    assert.ok(estimateInputTokens(request.messages, request.tools) < 20_000);
    if (request.trace?.phase === "architect_context_summary") return textResponse('{"summary":"Earlier conversation asked for a wooden shelter."}');
    assert.equal(request.trace?.phase, "architect");
    assert.match(request.messages[1]!.content!, /Earlier conversation asked/);
    assert.equal(request.messages.at(-1)!.content, delegation.userRequest);
    return tool("submit_blueprint", drawing);
  } };
  const { agent } = await setup(t, { llm });
  value(await agent.run({ ...delegation, conversation: [
    { role: "user", content: "Old description: " + "x".repeat(35_000) },
    { role: "assistant", content: "Old reply: " + "y".repeat(35_000) },
  ] }));
  assert.ok(requests.some(r => r.trace?.phase === "architect_context_summary"));
  assert.equal(requests.filter(r => r.trace?.phase === "architect").length, 1);
});

test("LLM timeout is a terminal structured error and leaves no open inspector call", async t => {
  const { agent, llm, inspector } = await setup(t);
  llm.enqueue(() => { throw new LLMError("TIMEOUT", "Model timed out"); });
  assert.equal(error(await agent.run(delegation)).code, "TIMEOUT");
  assert.equal(inspector.status().inProgressCount, 0);
  assert.match(inspector.listRounds()[0]!.outcome, /Model timed out/);
});

async function tickUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("Expected asynchronous boundary was not reached");
}
