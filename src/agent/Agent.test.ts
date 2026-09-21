import assert from "node:assert/strict";
import test from "node:test";
import { ChatIntentRouter } from "../chat/ChatIntentRouter";
import type {
  ExecutionController,
  ExecutionSnapshot,
} from "../execution/ExecutionController";
import { FakeLLMClient } from "../llm/FakeLLMClient";
import { LLMError } from "../llm/LLMError";
import { ConversationHistory } from "../memory/ConversationHistory";
import { RecentActivityBuffer } from "../memory/RecentActivityBuffer";
import { sleep } from "../shared/helper";
import { AgentContextBuilder } from "./AgentContextBuilder";
import { AgentToolBridge } from "./AgentToolBridge";
import { Agent } from "./Agent";

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
    intentRouter: new ChatIntentRouter(llm),
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

test("stop is immediate and preserves pending work", async () => {
  const llm = new FakeLLMClient();
  const fake = fakeController();
  const responses: string[] = [];
  const agent = new Agent({
    llm,
    intentRouter: new ChatIntentRouter(llm),
    contextBuilder: {} as AgentContextBuilder,
    toolBridge: {} as AgentToolBridge,
    controller: fake.controller,
    history: new ConversationHistory(),
    activities: new RecentActivityBuffer(),
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
    intentRouter: new ChatIntentRouter(llm),
    contextBuilder: {
      build: () => [{ role: "user", content: "resume review" }],
    } as unknown as AgentContextBuilder,
    toolBridge: {
      catalog: { build: () => [] },
    } as unknown as AgentToolBridge,
    controller: fake.controller,
    history: new ConversationHistory(),
    activities: new RecentActivityBuffer(),
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
    intentRouter: new ChatIntentRouter(llm),
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
  };
  const snapshot = (): ExecutionSnapshot => ({
    revision: state.revision,
    mode: "paused",
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
      return { ok: true, snapshot: snapshot(), taskIds: [] };
    },
    pause: () => ({ ok: true, snapshot: snapshot(), taskIds: [] }),
    resume: () => {
      state.resumeCalls += 1;
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state.");
    await sleep(5);
  }
}
