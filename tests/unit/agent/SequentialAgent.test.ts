import assert from "node:assert/strict";
import test from "node:test";
import { AgentContextBuilder } from "../../../src/agent/AgentContextBuilder";
import { MemoryUpdater } from "../../../src/agent/MemoryUpdater";
import { SequentialAgent } from "../../../src/agent/SequentialAgent";
import { WorkingMemory } from "../../../src/agent/WorkingMemory";
import type { AgentToolBridge } from "../../../src/agent/AgentToolBridge";
import { ChatIntentRouter } from "../../../src/chat/ChatIntentRouter";
import { SequentialPlanRunner } from "../../../src/execution/SequentialPlanRunner";
import type { Task } from "../../../src/execution/Task";
import {
  failure,
  success,
  type TaskResult,
} from "../../../src/execution/TaskResult";
import type { Executor } from "../../../src/execution/Executor";
import { FakeLLMClient } from "../../../src/llm/FakeLLMClient";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import type { CapabilityRegistry } from "../../../src/capabilities/CapabilityRegistry";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("question run answers, updates memory, then returns to idle", async () => {
  const { agent, llm, replies } = createHarness();
  enqueueIntent(llm, "readonly_question");
  enqueueAnswer(llm, "The chest is west.");
  enqueueMemory(llm, "Asked about the chest.");

  agent.submitUserMessage("owner", "où est le coffre ?");
  await waitForIdle(agent);

  assert.equal(agent.state().mode, "idle");
  assert.equal(replies.at(-1), "The chest is west.");
  assert.equal(llm.maxConcurrentRequests, 1);
  assert.equal(
    llm.requests.some((request) => request.trace?.phase === "memory"),
    true,
  );
});

test("set_plan does not execute and continue_plan runs exactly one task", async () => {
  const { agent, llm, executor, replies } = createHarness();
  enqueueIntent(llm, "action_request");
  enqueueDecision(llm, "set_plan", {
    tasks: [{ capability: "dig", input: { position: { x: 1, y: 2, z: 3 } } }],
  });
  enqueueMemory(llm, "Need to dig the target.");
  enqueueDecision(llm, "continue_plan", {});
  enqueueMemory(llm, "Authorized first dig.");
  executor.enqueue(success({ block: "dirt" }));
  enqueueDecision(llm, "finish_run", {
    status: "success",
    message: "The hole is ready.",
  });
  enqueueMemory(llm, "Dug the dirt.");

  agent.submitUserMessage("owner", "dig that block");
  await waitForIdle(agent);

  assert.equal(executor.started.length, 1);
  assert.equal(executor.started[0]?.capability, "dig");
  assert.equal(replies.at(-1), "The hole is ready.");
  assert.equal(llm.maxConcurrentRequests, 1);
});

test("ordinary messages are ignored while the agent is working", async () => {
  const { agent, llm } = createHarness();
  const deferred = llm.enqueueDeferred();

  agent.submitUserMessage("owner", "first question");
  await waitForMode(agent, "thinking");
  agent.submitUserMessage("owner", "second question");
  deferred.resolve({
    message: {
      role: "assistant",
      content: JSON.stringify({
        kind: "readonly_question",
        confidence: 5,
      }),
    },
    finishReason: "stop",
  });
  enqueueAnswer(llm, "Only the first question.");
  enqueueMemory(llm, "Answered first question.");
  await waitForIdle(agent);

  assert.equal(
    llm.requests.filter((request) => request.trace?.phase === "intent")
      .length,
    1,
  );
});

test("invalid responses retry without side effects then recover", async () => {
  const { agent, llm, executor, replies } = createHarness({
    maxResponseRetries: 8,
  });
  enqueueIntent(llm, "action_request");
  llm.enqueue({
    message: { role: "assistant", content: "not-a-decision" },
    finishReason: "stop",
  });
  enqueueDecision(llm, "set_plan", {
    tasks: [{ capability: "dig", input: { position: { x: 1, y: 2, z: 3 } } }],
  });
  enqueueMemory(llm, "Plan saved after a retry.");
  enqueueDecision(llm, "finish_run", {
    status: "needs_user",
    message: "I need a closer look before digging.",
  });
  enqueueMemory(llm, "Waiting for the user.");

  agent.submitUserMessage("owner", "dig something");
  await waitForIdle(agent);

  assert.equal(executor.started.length, 0);
  assert.equal(
    replies.some((line) =>
      line.includes("Invalid agent response. Retrying (1/8)"),
    ),
    true,
  );
  assert.equal(replies.at(-1), "I need a closer look before digging.");
});

test("stop and resume review the interrupted task instead of auto-retrying", async () => {
  const { agent, llm, executor, replies } = createHarness();
  enqueueIntent(llm, "action_request");
  enqueueDecision(llm, "set_plan", {
    tasks: [{ capability: "dig", input: { position: { x: 2, y: 3, z: 4 } } }],
  });
  enqueueMemory(llm, "Prepared a dig.");
  enqueueDecision(llm, "continue_plan", {});
  enqueueMemory(llm, "Starting the dig.");
  const deferred = executor.enqueueDeferred();

  agent.submitUserMessage("owner", "dig now");
  await waitForMode(agent, "executing");
  const stop = agent.requestStop("owner");
  deferred.resolve(
    failure("INTERRUPTED", "Stopped by user.", { retryable: true }),
  );
  await stop;
  assert.equal(agent.state().mode, "stopped");
  assert.equal(executor.started.length, 1);

  enqueueDecision(llm, "finish_run", {
    status: "failure",
    message: "I stopped before finishing the dig.",
  });
  enqueueMemory(llm, "Dig was interrupted.");
  agent.requestResume("owner");
  await waitForIdle(agent);

  assert.equal(executor.started.length, 1);
  assert.equal(replies.at(-1), "I stopped before finishing the dig.");
});

test("LLM never runs while a capability is executing", async () => {
  const { agent, llm, executor } = createHarness();
  enqueueIntent(llm, "action_request");
  enqueueDecision(llm, "set_plan", {
    tasks: [{ capability: "dig", input: { position: { x: 1, y: 2, z: 3 } } }],
  });
  enqueueMemory(llm, "Plan ready.");
  enqueueDecision(llm, "continue_plan", {});
  enqueueMemory(llm, "Go.");
  const deferred = executor.enqueueDeferred();

  agent.submitUserMessage("owner", "dig");
  await waitForMode(agent, "executing");
  const requestsWhileExecuting = llm.requests.length;
  await Promise.resolve();
  assert.equal(llm.requests.length, requestsWhileExecuting);
  assert.equal(llm.maxConcurrentRequests, 1);

  enqueueDecision(llm, "finish_run", {
    status: "success",
    message: "Done.",
  });
  enqueueMemory(llm, "Finished after the action.");
  deferred.resolve(success({ ok: true }));
  await waitForIdle(agent);
});

function createHarness(
  options: { maxResponseRetries?: number } = {},
): {
  agent: SequentialAgent;
  llm: FakeLLMClient;
  executor: ScriptedExecutor;
  replies: string[];
} {
  const llm = new FakeLLMClient();
  const executor = new ScriptedExecutor();
  const runner = new SequentialPlanRunner(executor as unknown as Executor);
  const workingMemory = new WorkingMemory(500);
  const replies: string[] = [];
  const memoryUpdater = new MemoryUpdater({
    llm,
    prompt: PromptTemplate.fromString(
      "memory",
      "max={{max_chars}}\n{{memory_input}}",
    ),
    memory: workingMemory,
    maxRetries: options.maxResponseRetries ?? 8,
    maxTokens: 200,
    notifyRetry: async (message) => {
      replies.push(message);
    },
  });
  const agent = new SequentialAgent({
    llm,
    intentRouter: new ChatIntentRouter(
      llm,
      PromptTemplate.fromString("intent", "Classify."),
    ),
    contextBuilder: new AgentContextBuilder({
      world,
      landmarks: { pinned: () => [] } as unknown as LandmarkMemory,
      capabilities: {
        list: () => [{ name: "dig", description: "Dig a block." }],
      } as unknown as CapabilityRegistry,
      systemPrompt: PromptTemplate.fromString(
        "system",
        "CTX {{current_context}}",
      ),
    }),
    toolBridge: stubBridge() as unknown as AgentToolBridge,
    runner,
    workingMemory,
    memoryUpdater,
    maxToolRounds: 2,
    maxResponseRetries: options.maxResponseRetries ?? 8,
    temperature: 0,
    maxTokens: 200,
    respond: async (message) => {
      replies.push(message);
    },
  });
  return { agent, llm, executor, replies };
}

function stubBridge() {
  return {
    catalog: { build: () => [] },
    async executeRead() {
      throw new Error("Unexpected read tool.");
    },
    validateResponseCalls(calls: readonly { name: string; arguments: string }[]) {
      if (calls.length !== 1) {
        throw new Error("Expected one decision.");
      }
      const call = calls[0]!;
      if (call.name === "set_plan") {
        return {
          kind: "decision",
          decision: {
            type: "set_plan",
            tasks: JSON.parse(call.arguments).tasks,
          },
        };
      }
      if (call.name === "continue_plan") {
        return { kind: "decision", decision: { type: "continue_plan" } };
      }
      if (call.name === "finish_run") {
        return {
          kind: "decision",
          decision: { type: "finish_run", ...JSON.parse(call.arguments) },
        };
      }
      throw new Error(`Unknown tool ${call.name}`);
    },
  };
}

function enqueueIntent(
  llm: FakeLLMClient,
  kind: "readonly_question" | "action_request",
): void {
  llm.enqueue({
    message: {
      role: "assistant",
      content: JSON.stringify({ kind, confidence: 5 }),
    },
    finishReason: "stop",
  });
}

function enqueueAnswer(llm: FakeLLMClient, message: string): void {
  llm.enqueue({
    message: {
      role: "assistant",
      content: JSON.stringify({ message }),
    },
    finishReason: "stop",
  });
}

function enqueueDecision(
  llm: FakeLLMClient,
  name: string,
  args: Record<string, unknown>,
): void {
  llm.enqueue({
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: `call_${name}`,
          name,
          arguments: JSON.stringify(args),
        },
      ],
    },
    finishReason: "tool_calls",
  });
}

function enqueueMemory(llm: FakeLLMClient, memory: string): void {
  llm.enqueue({
    message: {
      role: "assistant",
      content: JSON.stringify({ memory }),
    },
    finishReason: "stop",
  });
}

async function waitForIdle(agent: SequentialAgent): Promise<void> {
  await waitForMode(agent, "idle");
}

async function waitForMode(
  agent: SequentialAgent,
  mode: "idle" | "thinking" | "executing" | "stopped",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (agent.state().mode === mode) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for mode ${mode}.`);
}

const world: WorldQueries = {
  getSelf: () => ({
    position: { x: 0, y: -60, z: 0 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    onGround: true,
  }),
  getInventory: () => ({ items: [], selectedItem: null }),
  getBlock: () => null,
  findNearestBlocks: () => [],
  getNearbyEntities: () => [],
};

class ScriptedExecutor {
  readonly started: Task[] = [];
  currentTask: Task | null = null;
  private readonly queue: Array<TaskResult | DeferredTaskResult> = [];

  enqueue(result: TaskResult): void {
    this.queue.push(result);
  }

  enqueueDeferred(): DeferredTaskResult {
    const deferred = new DeferredTaskResult();
    this.queue.push(deferred);
    return deferred;
  }

  abortCurrent(): boolean {
    return true;
  }

  async execute(task: Task): Promise<TaskResult> {
    this.currentTask = task;
    this.started.push(task);
    const next = this.queue.shift();
    const result =
      next instanceof DeferredTaskResult
        ? await next.promise
        : (next ?? success({ ok: true }));
    this.currentTask = null;
    return result;
  }
}

class DeferredTaskResult {
  readonly promise: Promise<TaskResult>;
  private resolvePromise!: (result: TaskResult) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(result: TaskResult): void {
    this.resolvePromise(result);
  }
}
