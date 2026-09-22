import assert from "node:assert/strict";
import test from "node:test";
import type { ChatIntentRouter } from "../../../src/chat/ChatIntentRouter";
import type {
  ExecutionController,
  ExecutionSnapshot,
} from "../../../src/execution/ExecutionController";
import { FakeLLMClient } from "../../../src/llm/FakeLLMClient";
import { LLMError } from "../../../src/llm/LLMError";
import { ConversationHistory } from "../../../src/memory/ConversationHistory";
import { RecentActivityBuffer } from "../../../src/memory/RecentActivityBuffer";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { sleep } from "../../../src/shared/helper";
import { AgentContextBuilder } from "../../../src/agent/AgentContextBuilder";
import { AgentToolBridge } from "../../../src/agent/AgentToolBridge";
import { Agent, compactTurnForHistory } from "../../../src/agent/Agent";

const TEST_PROMPTS = {
  resumeReview: PromptTemplate.fromString("resume", "Review the plan."),
  executionFinished: PromptTemplate.fromString(
    "finished",
    "Task={{task}} Result={{result}} Revision={{revision}}",
  ),
  executionIdle: PromptTemplate.fromString(
    "idle",
    "Idle at revision {{revision}}",
  ),
};

test("capability schemas remain available in-turn but are compacted in history", () => {
  const messages = [
    { role: "user" as const, content: "coupe le bois" },
    {
      role: "assistant" as const,
      content: null,
      toolCalls: [
        {
          id: "schemas",
          name: "get_capability_schemas",
          arguments: '{"names":["goto","dig"]}',
        },
      ],
    },
    {
      role: "tool" as const,
      toolCallId: "schemas",
      content: JSON.stringify({
        ok: true,
        value: {
          capabilities: [
            {
              name: "goto",
              inputSchema: { distinctiveLargeGotoSchema: "x".repeat(2_000) },
            },
            {
              name: "dig",
              inputSchema: { distinctiveLargeDigSchema: "x".repeat(2_000) },
            },
          ],
        },
      }),
    },
    { role: "assistant" as const, content: "plan prêt" },
  ];

  const compacted = compactTurnForHistory(messages);
  const serialized = JSON.stringify(compacted);
  assert.match(serialized, /loadedCapabilitySchemas/);
  assert.match(serialized, /goto/);
  assert.match(serialized, /dig/);
  assert.doesNotMatch(serialized, /distinctiveLargeGotoSchema/);
  assert.doesNotMatch(serialized, /distinctiveLargeDigSchema/);
  assert.ok(JSON.stringify(messages).length > serialized.length + 3_000);

  const history = new ConversationHistory();
  assert.equal(history.appendTurn(compacted), true);
});

test("a late stale generation cannot execute tools", async () => {
  const llm = new FakeLLMClient();
  const first = llm.enqueueDeferred({ ignoreAbort: true });
  llm.enqueue({
    message: { role: "assistant", content: "deuxième réponse" },
    finishReason: "stop",
  });
  const toolCalls: string[] = [];
  const responses: string[] = [];
  const history = new ConversationHistory();
  const agent = new Agent({
    llm,
    intentRouter: testIntentRouter(),
    contextBuilder: {
      build: ({ currentInput }: { currentInput: string }) => [
        { role: "system", content: "system" },
        { role: "user", content: currentInput },
      ],
    } as unknown as AgentContextBuilder,
    toolBridge: {
      catalog: { build: () => [] },
      execute: async (call: { name: string }) => {
        toolCalls.push(call.name);
        return {
          toolCallId: "x",
          name: call.name,
          ok: true,
          content: '{"ok":true}',
        };
      },
    } as unknown as AgentToolBridge,
    controller: fakeController().controller,
    history,
    activities: new RecentActivityBuffer(),
    prompts: TEST_PROMPTS,
    maxToolRounds: 3,
    temperature: 0,
    maxTokens: 100,
    turnTimeoutMs: 5_000,
    respond: async (message) => {
      responses.push(message);
    },
  });
  agent.start();

  agent.submitUserMessage("owner", "construis une table");
  await waitUntil(() => llm.requests.length === 1);
  agent.submitUserMessage("owner", "fabrique une pioche");
  first.resolve({
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "stale-call",
          name: "enqueue_tasks",
          arguments: "{}",
        },
      ],
    },
    finishReason: "tool_calls",
  });

  await waitUntil(() => responses.includes("deuxième réponse"));
  assert.deepEqual(toolCalls, []);
  assert.equal(llm.maxConcurrentRequests, 1);
  assert.equal(history.turnCount(), 1);
  await agent.shutdown();
});

test("a token-limited response is discarded before any tool executes", async () => {
  const llm = new FakeLLMClient();
  llm.enqueue({
    message: {
      role: "assistant",
      content: "partial",
      toolCalls: [
        {
          id: "truncated-call",
          name: "enqueue_tasks",
          arguments: '{"tasks":',
        },
      ],
    },
    finishReason: "length",
  });
  const toolCalls: string[] = [];
  const responses: string[] = [];
  const history = new ConversationHistory();
  const agent = new Agent({
    llm,
    intentRouter: testIntentRouter(),
    contextBuilder: {
      build: () => [{ role: "user", content: "action" }],
    } as unknown as AgentContextBuilder,
    toolBridge: {
      catalog: { build: () => [] },
      execute: async (call: { name: string }) => {
        toolCalls.push(call.name);
        return {
          toolCallId: "x",
          name: call.name,
          ok: true,
          content: '{"ok":true}',
        };
      },
    } as unknown as AgentToolBridge,
    controller: fakeController().controller,
    history,
    activities: new RecentActivityBuffer(),
    prompts: TEST_PROMPTS,
    maxToolRounds: 3,
    temperature: 0,
    maxTokens: 100,
    turnTimeoutMs: 5_000,
    respond: async (message) => {
      responses.push(message);
    },
  });
  agent.start();
  agent.submitUserMessage("owner", "construis une table");

  await waitUntil(() => responses.some((message) => message.includes("limite de tokens")));
  assert.deepEqual(toolCalls, []);
  assert.equal(history.turnCount(), 0);
  await agent.shutdown();
});

test("stop is immediate and preserves pending work", async () => {
  const llm = new FakeLLMClient();
  const fake = fakeController();
  const responses: string[] = [];
  const agent = new Agent({
    llm,
    intentRouter: testIntentRouter(),
    contextBuilder: {} as AgentContextBuilder,
    toolBridge: {} as AgentToolBridge,
    controller: fake.controller,
    history: new ConversationHistory(),
    activities: new RecentActivityBuffer(),
    prompts: TEST_PROMPTS,
    maxToolRounds: 3,
    temperature: 0,
    maxTokens: 100,
    turnTimeoutMs: 5_000,
    respond: async (message) => {
      responses.push(message);
    },
  });

  await agent.requestStop("owner");

  assert.equal(agent.state().manualStopped, true);
  assert.equal(fake.abortCalls, 1);
  assert.equal(fake.pendingCount, 1);
  assert.deepEqual(responses, ["Arrêt demandé.", "Bot arrêté."]);
});

test("failed resume review keeps manual stop sticky", async () => {
  const llm = new FakeLLMClient();
  llm.enqueue(async () => {
    throw new LLMError("UNAVAILABLE", "offline");
  });
  const fake = fakeController();
  const responses: string[] = [];
  const agent = new Agent({
    llm,
    intentRouter: testIntentRouter(),
    contextBuilder: {
      build: () => [{ role: "user", content: "resume review" }],
    } as unknown as AgentContextBuilder,
    toolBridge: {
      catalog: { build: () => [] },
    } as unknown as AgentToolBridge,
    controller: fake.controller,
    history: new ConversationHistory(),
    activities: new RecentActivityBuffer(),
    prompts: TEST_PROMPTS,
    maxToolRounds: 3,
    temperature: 0,
    maxTokens: 100,
    turnTimeoutMs: 5_000,
    respond: async (message) => {
      responses.push(message);
    },
  });
  agent.start();
  await agent.requestStop("owner");
  agent.requestResume("owner");

  await waitUntil(() => responses.some((message) => message.includes("Ollama")));
  assert.equal(agent.state().manualStopped, true);
  assert.equal(fake.resumeCalls, 0);
  await agent.shutdown();
});

test("a successful action plan starts a newly queued future", async () => {
  const llm = new FakeLLMClient();
  llm.enqueue({
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "enqueue",
          name: "enqueue_tasks",
          arguments: '{"tasks":[],"expectedRevision":0}',
        },
      ],
    },
    finishReason: "tool_calls",
  });
  llm.enqueue({
    message: { role: "assistant", content: "plan prêt" },
    finishReason: "stop",
  });
  const fake = fakeController();
  const agent = new Agent({
    llm,
    intentRouter: testIntentRouter(),
    contextBuilder: {
      build: () => [{ role: "user", content: "action" }],
    } as unknown as AgentContextBuilder,
    toolBridge: {
      catalog: { build: () => [] },
      execute: async () => ({
        toolCallId: "enqueue",
        name: "enqueue_tasks",
        ok: true,
        content: '{"ok":true}',
      }),
    } as unknown as AgentToolBridge,
    controller: fake.controller,
    history: new ConversationHistory(),
    activities: new RecentActivityBuffer(),
    prompts: TEST_PROMPTS,
    maxToolRounds: 3,
    temperature: 0,
    maxTokens: 100,
    turnTimeoutMs: 5_000,
    respond: async () => undefined,
  });
  agent.start();
  agent.submitUserMessage("owner", "construis une table");

  await waitUntil(() => fake.resumeCalls === 1);
  assert.equal(agent.state().manualStopped, false);
  await agent.shutdown();
});

test("a committed action plan keeps running when the next LLM round is superseded", async () => {
  const llm = new FakeLLMClient();
  llm.enqueue({
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "enqueue",
          name: "enqueue_tasks",
          arguments: '{"tasks":[],"expectedRevision":0}',
        },
      ],
    },
    finishReason: "tool_calls",
  });
  const staleFollowUp = llm.enqueueDeferred({ ignoreAbort: true });
  llm.enqueue({
    message: { role: "assistant", content: "Le plan continue." },
    finishReason: "stop",
  });
  const fake = fakeController();
  const responses: string[] = [];
  const agent = new Agent({
    llm,
    intentRouter: testIntentRouter(),
    contextBuilder: {
      build: () => [{ role: "user", content: "turn" }],
    } as unknown as AgentContextBuilder,
    toolBridge: {
      catalog: { build: () => [] },
      execute: async () => ({
        toolCallId: "enqueue",
        name: "enqueue_tasks",
        ok: true,
        content: '{"ok":true}',
      }),
    } as unknown as AgentToolBridge,
    controller: fake.controller,
    history: new ConversationHistory(),
    activities: new RecentActivityBuffer(),
    prompts: TEST_PROMPTS,
    maxToolRounds: 3,
    temperature: 0,
    maxTokens: 100,
    turnTimeoutMs: 5_000,
    respond: async (message) => {
      responses.push(message);
    },
  });
  agent.start();
  agent.submitUserMessage("owner", "construis une table");

  await waitUntil(() => llm.requests.length === 2);
  assert.equal(fake.resumeCalls, 1);

  agent.submitUserMessage("owner", "où est le coffre ?");
  staleFollowUp.resolve({
    message: { role: "assistant", content: "réponse obsolète" },
    finishReason: "stop",
  });

  await waitUntil(() => responses.includes("Le plan continue."));
  assert.equal(fake.resumeCalls, 1);
  await agent.shutdown();
});

function fakeController(): {
  controller: ExecutionController;
  abortCalls: number;
  resumeCalls: number;
  pendingCount: number;
} {
  const state = {
    abortCalls: 0,
    resumeCalls: 0,
    pendingCount: 1,
    revision: 0,
    mode: "paused" as "paused" | "draining",
  };
  const snapshot = (): ExecutionSnapshot => ({
    revision: state.revision,
    mode: state.mode,
    current: null,
    pending: [
      {
        id: "pending",
        capability: "test",
        input: {},
        createdAt: 1,
      },
    ],
    shutdown: false,
  });
  const controller = {
    snapshot,
    abortCurrent: () => {
      state.abortCalls += 1;
      state.mode = "paused";
      return { ok: true, snapshot: snapshot(), taskIds: [] };
    },
    pause: () => {
      state.mode = "paused";
      return { ok: true, snapshot: snapshot(), taskIds: [] };
    },
    resume: () => {
      state.resumeCalls += 1;
      state.mode = "draining";
      return { ok: true, snapshot: snapshot(), taskIds: [] };
    },
  } as unknown as ExecutionController;
  return {
    controller,
    get abortCalls() {
      return state.abortCalls;
    },
    get pendingCount() {
      return state.pendingCount;
    },
    get resumeCalls() {
      return state.resumeCalls;
    },
  };
}

function testIntentRouter(): ChatIntentRouter {
  return {
    route: async (text: string) =>
      text.includes("où")
        ? { kind: "readonly_question", confidence: 5 }
        : { kind: "action_request", confidence: 5 },
  } as ChatIntentRouter;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state.");
    await sleep(5);
  }
}
