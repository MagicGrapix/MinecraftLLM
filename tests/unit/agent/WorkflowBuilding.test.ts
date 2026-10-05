import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import minecraftData from "minecraft-data";
import { ArchitectAgent } from "../../../src/agent/ArchitectAgent";
import { ArchitectTools } from "../../../src/agent/ArchitectTools";
import { ActionContextBuilder } from "../../../src/agent/ActionContextBuilder";
import type { ActionDelegation, ActionRunner } from "../../../src/agent/ActionTypes";
import { WorkflowAgent } from "../../../src/agent/WorkflowAgent";
import { WorkflowSummaryFile } from "../../../src/agent/WorkflowState";
import { ToolCatalogBuilder } from "../../../src/agent/ToolCatalogBuilder";
import { BlueprintStore } from "../../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { createCapabilityRegistry } from "../../../src/bootstrap/createCapabilities";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import { ToolCallJournal } from "../../../src/execution/ToolCallJournal";
import type { LLMResponse } from "../../../src/llm/LLMClient";
import { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { loadWorkflowPrompts } from "../../../src/prompts/WorkflowPrompts";
import type { ContainerSessionManager } from "../../../src/runtime/ContainerSessionManager";
import { MaterialCatalog } from "../../../src/world/MaterialCatalog";
import type { WorldQueries } from "../../../src/world/WorldQueries";
import { createDefaultWorldQueryRegistry } from "../../../src/world/queries/defaultQueries";
import { createLookupMaterialQuery } from "../../../src/world/queries/LookupMaterial";
import { blueprintFixture } from "../../support/blueprints";
import { FakeLLMClient } from "../../support/FakeLLMClient";
import { until } from "../../e2e/async";

const catalog = new MaterialCatalog(minecraftData("1.21.11"));
const tool = (name: string, args: unknown): LLMResponse => ({
  message: { role: "assistant", content: null, toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }] }, finishReason: "tool_calls",
});
const plan: LLMResponse = { message: { role: "assistant", content: JSON.stringify({ steps: [{ title: "Build house", successCriteria: "All blueprint cells verified" }] }) }, finishReason: "stop" };
const reply = tool("reply", { message: "Done", outcome: "answer" });

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "minecraft-workflow-building-"));
  const llm = new FakeLLMClient(), inspector = new AgentInspector(100);
  const prompts = await loadWorkflowPrompts(resolve("prompts"));
  const world = {
    getSelf: () => ({ position: { x: 0, y: -60, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, onGround: true }),
    getInventory: () => ({ items: [], selectedItem: null }),
  } as unknown as WorldQueries;
  const landmarks = await LandmarkMemory.load(join(root, "landmarks.json"));
  const store = new BlueprintStore(new BlueprintValidator(catalog), { directory: join(root, "blueprints") });
  const journal = new ToolCallJournal(() => ({}));
  const queries = createDefaultWorldQueryRegistry(world, journal);
  queries.register(createLookupMaterialQuery(catalog));
  const tools = new ArchitectTools(catalog, store);
  const architectAgent = new ArchitectAgent({ llm, tools, journal, inspector, prompt: prompts.architect, contextSummaryPrompt: prompts.contextSummary });
  const delegations: ActionDelegation[] = [];
  const actionAgent: ActionRunner = {
    state: () => ({ mode: "idle" }), requestStop: async () => {}, shutdown: async () => {},
    runDelegatedStep: async d => {
      delegations.push(structuredClone(d));
      return { status: "success", message: "Scripted successful report; not a live building.", outcomes: [] };
    },
  };
  const summaryFile = new WorkflowSummaryFile("building-test", root);
  const replies: string[] = [];
  const agent = new WorkflowAgent({
    llm, architectAgent, actionAgent, world, landmarks, queries, journal, prompts, inspector,
    actionTools: new ToolCatalogBuilder(createCapabilityRegistry({} as ContainerSessionManager), queries).build(),
    temperature: 0, maxTokens: 4096, maxRetries: 0, summaryFile,
    respond: async message => { replies.push(message); },
  });
  t.after(async () => { await agent.shutdown(); await rm(root, { recursive: true, force: true }); });
  const idle = () => until(() => (agent.state() as { mode: string }).mode === "idle", 5000, "Workflow idle");
  return { agent, llm, inspector, store, tools, queries, journal, delegations, summaryFile, replies, idle,
    contextBuilder: new ActionContextBuilder({ world, landmarks, systemPrompt: prompts.actioner, conversationSummaryPrompt: prompts.conversationSummary }) };
}

test("design-only workflow selects saved metadata without planning or acting; next request clears selection", async t => {
  const h = await setup(t);
  h.llm.enqueue(tool("ask_architect", { instruction: "Design only, five by five, an oak door." }));
  h.llm.enqueue(tool("submit_blueprint", await blueprintFixture(true)));
  h.llm.enqueue(reply);
  h.agent.submitUserMessage("player", "Draw a house. Do not build it.");
  await h.idle();
  assert.equal(h.delegations.length, 0);
  assert.equal(h.agent.task.steps.length, 0);
  assert.equal(h.agent.task.construction!.blueprint.materials.find(m => m.item === "oak_door")!.quantity, 1);
  const id = h.agent.task.construction!.blueprint.blueprintId;
  assert.ok((await h.store.load(id)).ok);
  const coordinator = h.llm.requests[2]!;
  assert.match(coordinator.messages[0]!.content!, new RegExp(id));
  assert.doesNotMatch(JSON.stringify(coordinator.messages), /"layers"|"palette"/);
  assert.deepEqual(h.llm.requests[1]!.tools!.map(t => t.name), ["lookup_material", "submit_blueprint"]);
  assert.equal(h.llm.requests[1]!.messages.filter(m => m.role === "user").length, 1);
  assert.ok(!h.llm.requests[0]!.tools!.some(t => ["build", "submit_blueprint"].includes(t.name)));
  assert.equal(h.journal.get(1)!.tool, "ask_architect");
  assert.equal(h.journal.get(2)!.tool, "submit_blueprint");
  assert.equal(h.journal.get(2)!.tracksInventory, false);
  assert.equal(h.journal.get(2)!.completed, true);
  assert.ok(h.inspector.listRounds().some(r => r.outcome.includes("validated, not built")));
  assert.match(await readFile(h.summaryFile.path, "utf8"), new RegExp(id));
  h.llm.enqueue(reply);
  h.agent.submitUserMessage("player", "Hello");
  await h.idle();
  assert.equal(h.agent.task.construction, null);
  assert.match(h.llm.requests.at(-1)!.messages[0]!.content!, /No blueprint selected for this request/);
});

test("construction handoff pins the same blueprint, quantities and constraints across replanning and delegation", async t => {
  const h = await setup(t);
  h.llm.enqueue(tool("ask_architect", { instruction: "Five by five with one door, keep the lawn." }));
  h.llm.enqueue(tool("submit_blueprint", await blueprintFixture(true)));
  h.llm.enqueue(tool("ask_planner", { instruction: "Prepare stock then build the selected drawing." }));
  h.llm.enqueue(plan);
  h.llm.enqueue(tool("ask_planner", { instruction: "Stock is supplied, revise to construction only." }));
  h.llm.enqueue(plan);
  h.llm.enqueue(tool("run_step", { step: 1, instruction: "Build on the observed lawn." }));
  h.llm.enqueue(tool("complete_step", { step: 1 }));
  h.llm.enqueue(tool("reply", { message: "Built", outcome: "success" }));
  h.agent.submitUserMessage("player", "Build a house.");
  await h.idle();
  assert.deepEqual(h.replies, ["Built"]);
  assert.equal(h.agent.task.steps[0]!.status, "done");
  const construction = h.agent.task.construction!;
  for (const request of h.llm.requests.filter(r => r.trace?.phase === "planner")) {
    assert.equal(request.tools, undefined);
    assert.match(request.messages[0]!.content!, new RegExp(construction.blueprint.blueprintId));
    assert.match(request.messages[0]!.content!, /oak_planks x55/);
    assert.match(request.messages[0]!.content!, /### build|### lookup_material/);
  }
  assert.deepEqual(h.delegations[0]!.construction, construction);
  const built = h.contextBuilder.build({ delegation: h.delegations[0]!, lastTask: null, lastResult: null, conversationSummary: "Earlier activity compacted." });
  assert.match(built.messages[0]!.content!, /oak_door x1|keep the lawn/);
  assert.match(built.messages[0]!.content!, new RegExp(construction.blueprint.blueprintId));
  assert.doesNotMatch(built.messages[0]!.content!, /"layers"/);
  const snapshot = h.agent.task.snapshot();
  Reflect.set(snapshot.construction!.blueprint.materials, 0, { item: "dirt", quantity: 1 });
  assert.notDeepEqual(snapshot.construction, h.agent.task.construction);
});

test("replacement blueprint clears old verified steps and reports; failed redesign keeps the current reference", async t => {
  const h = await setup(t), drawing = await blueprintFixture(true);
  let firstId = "";
  h.llm.enqueue(tool("ask_architect", { instruction: "First design" }));
  h.llm.enqueue(tool("submit_blueprint", drawing));
  h.llm.enqueue(tool("ask_planner", { instruction: "Build" })); h.llm.enqueue(plan);
  h.llm.enqueue(tool("run_step", { step: 1, instruction: "Build" }));
  h.llm.enqueue(tool("complete_step", { step: 1 }));
  h.llm.enqueue(() => {
    firstId = h.agent.task.construction!.blueprint.blueprintId;
    assert.equal(h.agent.task.steps[0]!.status, "done");
    return tool("ask_architect", { instruction: "Revised design" });
  });
  h.llm.enqueue(tool("submit_blueprint", { ...drawing, name: "Revised" }));
  h.llm.enqueue(() => {
    assert.notEqual(h.agent.task.construction!.blueprint.blueprintId, firstId);
    assert.deepEqual(h.agent.task.steps, []);
    assert.deepEqual(h.agent.task.reports, {});
    assert.equal(h.agent.task.currentStep, null);
    return tool("ask_architect", { instruction: "Try another design" });
  });
  h.llm.enqueue({ ...tool("submit_blueprint", drawing), finishReason: "length" });
  h.llm.enqueue(request => {
    const result = JSON.parse(request.messages.at(-1)!.content!);
    assert.equal(result.ok, false);
    assert.equal(result.error.facts.reason, "TRUNCATED_RESPONSE");
    assert.equal(h.agent.task.construction!.blueprint.name, "Revised");
    return reply;
  });
  h.agent.submitUserMessage("player", "Build and revise"); await h.idle();
  assert.deepEqual(h.replies, ["Done"]);
});

test("stop waits for an uncooperative Architect call and does not install its late blueprint; resume replays a paired failure", async t => {
  const h = await setup(t);
  h.llm.enqueue(tool("ask_architect", { instruction: "Create a house" }));
  const deferred = h.llm.enqueueDeferred({ ignoreAbort: true });
  h.agent.submitUserMessage("player", "Build house");
  await until(() => h.llm.requests.length === 2, 3000, "Architect called");
  let settled = false;
  const stop = h.agent.requestStop("player").then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(settled, false);
  deferred.resolve(tool("submit_blueprint", await blueprintFixture(true)));
  await stop;
  assert.equal(h.agent.task.construction, null);
  assert.equal(h.journal.get(1)!.completed, true);
  h.llm.enqueue(request => {
    const result = request.messages.at(-1)!;
    assert.equal(result.role, "tool");
    assert.equal(JSON.parse(result.content!).ok, false);
    return reply;
  });
  h.agent.requestResume("player"); await h.idle();
  assert.equal(h.replies.at(-1), "Done");
});

test("shared material lookup has identical Architect and world-query contracts without world access", async t => {
  const h = await setup(t);
  for (const query of ["oak_plate", "oak_door", "diamond_block"]) {
    const call = tool("lookup_material", { query }).message.toolCalls![0]!;
    const architect = await h.tools.execute(call, new AbortController().signal);
    const general = await h.queries.execute("lookup_material", { query });
    assert.deepEqual(architect.result, general);
  }
  const invalid = await h.queries.execute("lookup_material", { query: "" });
  assert.ok(!invalid.ok && invalid.error.code === "INVALID_ARGUMENT");
});

test("selected blueprint survives actual coordinator compression and still reaches the planner", async t => {
  const h = await setup(t);
  h.llm.enqueue(tool("ask_architect", { instruction: "Keep an oak door" }));
  h.llm.enqueue(tool("submit_blueprint", await blueprintFixture(true)));
  let rounds = 0;
  for (let i = 0; i < 65; i++) h.llm.enqueue(request => {
    if (request.trace?.phase === "context_summary") return { message: { role: "assistant", content: '{"summary":"Observed the world repeatedly."}' }, finishReason: "stop" };
    if (request.trace?.phase === "planner") return plan;
    const n = rounds++;
    const call = n < 40 ? tool("get_self", {}) : n === 40 ? tool("ask_planner", { instruction: "Build selected house" }) : reply;
    return { ...call, message: { ...call.message, content: "Observe current terrain. ".repeat(100) } };
  });
  h.agent.submitUserMessage("player", "House with oak door"); await h.idle();
  assert.ok(h.llm.requests.some(r => r.trace?.phase === "context_summary"));
  const planner = h.llm.requests.find(r => r.trace?.phase === "planner")!;
  assert.ok(planner);
  assert.match(planner.messages[0]!.content!, new RegExp(h.agent.task.construction!.blueprint.blueprintId));
  assert.match(planner.messages[0]!.content!, /Keep an oak door|oak_door x1/);
  assert.equal(planner.messages.at(-1)!.content, "House with oak door");
});
