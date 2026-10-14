import assert from "node:assert/strict";
import test from "node:test";
import { PlannerAgent } from "../../../src/agent/PlannerAgent";
import type { ContextBudget } from "../../../src/agent/ContextCompactor";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { ToolCallJournal } from "../../../src/execution/ToolCallJournal";
import type { LLMResponse } from "../../../src/llm/LLMClient";
import { estimateInputTokens } from "../../../src/llm/InputBudget";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { FakeLLMClient } from "../../support/FakeLLMClient";
import { loadRecipeTools } from "../../support/recipes";

let nextId = 0;
const call = (name: string, args: unknown): LLMResponse => ({ message: { role: "assistant", content: null,
  toolCalls: [{ id: `call-${++nextId}`, name, arguments: JSON.stringify(args) }] }, finishReason: "tool_calls" });
const steps = [{ title: "Craft a wooden axe using oak variant", successCriteria: "One wooden_axe in inventory after crafting from 3 oak_planks and 2 stick at a crafting table." }];

async function harness(options: { maxCalls?: number; maxRetries?: number; contextBudget?: ContextBudget } = {}) {
  const llm = new FakeLLMClient(), inspector = new AgentInspector(100);
  let inventoryReads = 0;
  const journal = new ToolCallJournal(() => { inventoryReads++; return {}; });
  const agent = new PlannerAgent({ llm, inspector, journal, recipes: await loadRecipeTools(),
    maxTokens: 4096, maxRetries: options.maxRetries ?? 2, temperature: 0,
    contextSummaryPrompt: PromptTemplate.fromString("summary", "Summarize {{summary_input}} under {{max_chars}} chars."),
    maxCalls: options.maxCalls, contextBudget: options.contextBudget });
  const run = (extra: { signal?: AbortSignal; system?: string } = {}) => agent.run({
    conversation: [{ role: "user", content: "Craft an axe then build a wood shelter." }], conversationSummary: "",
    objective: "Craft an axe then build a wood shelter.", generationId: 1, reflection: 2,
    signal: extra.signal ?? new AbortController().signal,
    render: (messages, summary) => ({ messages: [{ role: "system", content: extra.system ?? "Plan using recipe knowledge." },
      { role: "assistant", content: `Previous conversation summary: ${summary || "empty"}` }, ...messages],
      context: { objective: "Craft an axe then build a wood shelter." } }),
  });
  return { agent, llm, inspector, journal, run, inventoryReads: () => inventoryReads };
}

test("planner consults recipes in one private native conversation then returns only a validated plan and coverage", async () => {
  const h = await harness();
  const coordinatorNumber = h.journal.start("ask_planner", false, { agent: "coordinator", generationId: 1, toolCallId: "parent", arguments: "{}" });
  assert.equal(coordinatorNumber, 1);
  h.llm.enqueue(call("search_recipes", { query: "axe" }));
  h.llm.enqueue(call("read_recipe", { item: "wooden_axe" }));
  h.llm.enqueue(call("read_recipe", { item: "stick" }));
  h.llm.enqueue(call("read_recipe", { item: "diamond_axe" }));
  h.llm.enqueue(call("submit_plan", { steps }));
  const report = await h.run();
  assert.deepEqual(report.steps, steps);
  assert.deepEqual(report.recipeCoverage, { consulted: ["wooden_axe#1", "stick#1"], unavailable: [{ item: "diamond_axe", code: "RECIPE_MISSING" }] });
  assert.equal(h.inventoryReads(), 0);
  assert.deepEqual(h.llm.requests[0]!.tools!.map(t => t.name), ["search_recipes", "read_recipe", "submit_plan"]);
  assert.equal(h.llm.requests[0]!.responseFormat, undefined);
  assert.equal(h.llm.requests[0]!.maxTokens, 4096);
  const history = h.llm.requests.at(-1)!.messages;
  assert.match(history.find(m => m.role === "tool" && m.content.includes("wooden_axe x1 per craft"))!.content!, /\[A\] \[A\] \[ \]/);
  assert.match(history.at(-1)!.content!, /RECIPE_MISSING/);
  assert.ok(!JSON.stringify(report).includes("[A]"));
  const rounds = h.inspector.listRounds();
  assert.deepEqual(rounds.map(r => h.inspector.getRound(r.id)!.toolExecutions[0]!.actionNumber), [2, 3, 4, 5, 6]);
  assert.equal(rounds[3]!.failed, true);
  assert.match(rounds[4]!.outcome, /Checklist created — 1 steps/);
  const raw = JSON.parse(h.inspector.getRound(rounds[1]!.id)!.toolExecutions[0]!.result!);
  assert.equal(raw.value.ingredients.oak_planks, 3);
  assert.equal(h.journal.get(3)!.tracksInventory, false);
  h.llm.enqueue(call("submit_plan", { steps }));
  await h.run();
  assert.equal(h.llm.requests.at(-1)!.messages.length, 3, "A new delegation must not retain the previous tool conversation");
});

test("invalid arguments, unknown tools and invalid plans get paired error results before correction", async () => {
  const h = await harness({ maxRetries: 3 });
  h.llm.enqueue(call("read_recipe", { item: "../secret" }));
  h.llm.enqueue(call("dig", { position: { x: 0, y: 0, z: 0 } }));
  h.llm.enqueue(call("submit_plan", { steps: [] }));
  h.llm.enqueue(call("submit_plan", { steps }));
  assert.deepEqual((await h.run()).steps, steps);
  assert.match(h.llm.requests[1]!.messages.at(-1)!.content!, /INVALID_ARGUMENT/);
  assert.match(h.llm.requests[2]!.messages.at(-1)!.content!, /capabilities belong to the action agent/);
  assert.match(h.llm.requests[3]!.messages.at(-1)!.content!, /steps/);
  assert.deepEqual(h.inspector.listRounds().map(r => r.failed), [true, true, true, false]);
});

test("truncated or text-only output never executes a proposed tool and is retried within configured limits", async () => {
  const h = await harness();
  h.llm.enqueue({ ...call("submit_plan", { steps }), finishReason: "length" });
  h.llm.enqueue({ message: { role: "assistant", content: '{"steps":[]}' }, finishReason: "stop" });
  h.llm.enqueue(call("submit_plan", { steps }));
  assert.deepEqual((await h.run()).steps, steps);
  assert.equal(h.journal.get(1)!.tool, "submit_plan");
  assert.equal(h.journal.get(2), undefined);
  assert.match(h.llm.requests[1]!.messages[0]!.content!, /truncated/);
  assert.match(h.llm.requests[2]!.messages[0]!.content!, /Text alone does not submit a plan/);
  assert.doesNotMatch(h.llm.requests[2]!.messages[0]!.content!, /Output was truncated/);
});

test("retry and tool-call limits terminate without a fabricated plan", async () => {
  const h = await harness({ maxCalls: 2 });
  h.llm.enqueue(call("read_recipe", { item: "stick" }));
  h.llm.enqueue(call("read_recipe", { item: "stick" }));
  await assert.rejects(h.run(), /call limit/);
  assert.equal(h.inspector.listRounds().at(-1)!.status, "tool_round_limit");
  const invalid = await harness({ maxRetries: 0 });
  invalid.llm.enqueue(call("submit_plan", { steps: [] }));
  await assert.rejects(invalid.run(), /retries exhausted/);
  assert.equal(invalid.llm.requests.length, 1);
});

test("abort rejects even an uncooperative late LLM response before submitting its plan", async () => {
  const h = await harness();
  const deferred = h.llm.enqueueDeferred({ ignoreAbort: true });
  const controller = new AbortController();
  const running = h.run({ signal: controller.signal });
  while (!h.llm.requests.length) await new Promise(r => setTimeout(r, 1));
  controller.abort(new Error("Stopped"));
  deferred.resolve(call("submit_plan", { steps }));
  await assert.rejects(running, /Stopped/);
  assert.equal(h.journal.get(1), undefined);
  assert.equal(h.inspector.listRounds()[0]!.status, "aborted");
});

test("protected input over 20k is rejected without contacting the model", async () => {
  const h = await harness();
  await assert.rejects(h.run({ system: "x".repeat(60_000) }), /protected|Protected/);
  assert.equal(h.llm.requests.length, 0);
});

test("planner compacts its own transcript while protecting the request and latest tool exchange", async () => {
  const h = await harness({ maxCalls: 32, contextBudget: { charsPerToken: 3, compactAtTokens: 1800, targetTokens: 1000, summaryMaxChars: 100 } });
  let calls = 0;
  for (let i = 0; i < 80; i++) h.llm.enqueue(request => {
    if (request.trace?.phase === "planner_context_summary") return { message: { role: "assistant", content: '{"summary":"Axe: 3 planks, 2 sticks, table. Stick craft yields four."}' }, finishReason: "stop" };
    return ++calls < 20 ? call("read_recipe", { item: "wooden_axe" }) : call("submit_plan", { steps });
  });
  assert.deepEqual((await h.run()).steps, steps);
  assert.ok(h.llm.requests.some(r => r.trace?.phase === "planner_context_summary"));
  const last = h.llm.requests.at(-1)!;
  assert.equal(last.messages.find(m => m.role === "user")!.content, "Craft an axe then build a wood shelter.");
  assert.match(last.messages.at(-1)!.content!, /wooden_axe x1/);
  assert.ok(h.llm.requests.every(r => estimateInputTokens(r.messages, r.tools) < 20_000));
});
