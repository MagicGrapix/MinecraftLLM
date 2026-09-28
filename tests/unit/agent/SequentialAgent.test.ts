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

test("delegated action skips intent routing and returns a private report", async () => {
  const { agent, llm, replies, workingMemory } = createHarness({ noMemory: true });
  workingMemory.replace("stale context from an earlier delegation");
  enqueueDecision(llm, "finish_run", { status: "success", message: "Step verified." });

  const report = await agent.runDelegatedStep("Collect one log.", {
    generationId: 42,
    delegation: 2,
  });

  assert.equal(report.status, "success");
  assert.equal(report.message, "Step verified.");
  assert.deepEqual(report.outcomes, []);
  assert.equal(workingMemory.read(), "");
  assert.deepEqual(replies, []);
  assert.deepEqual(llm.requests.map((request) => request.trace?.phase), ["actioner_planning"]);
  assert.equal(llm.requests[0]?.trace?.generationId, 42);
  assert.equal(llm.requests[0]?.trace?.reflection, 2001);
});

test("actioner keeps a bounded transcript across actions and clears it between delegations", async () => {
  const { agent, llm, executor } = createHarness({ noMemory: true });
  enqueueDecision(llm, "set_plan", {
    tasks: Array.from({ length: 12 }, (_, x) => ({ capability: "dig", input: { position: { x, y: 2, z: 3 } } })),
  });
  for (let i = 0; i < 12; i++) {
    enqueueDecision(llm, "continue_plan", {});
    executor.enqueue(success({ block: `observed_${i}` }));
  }
  enqueueDecision(llm, "finish_run", { status: "success", message: "All twelve tasks done." });
  const report = await agent.runDelegatedStep("Distinct first delegation.");
  assert.equal(report.outcomes.length, 12);
  assert.equal(executor.started.length, 12);
  const requests = llm.requests;
  assert.match(requests[2]!.messages.at(-1)!.content!, /observed_0/);
  assert.ok(requests[2]!.messages.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "set_plan"));
  for (const request of requests) {
    assert.ok(request.messages.length <= 20);
    assert.equal(request.messages[0]!.role, "system");
    assert.equal(request.messages[1]!.role, "assistant");
    assert.match(request.messages[1]!.content!, /Previous conversation summary: empty/);
    assert.equal(request.messages.filter((m) => m.content?.startsWith("Previous conversation summary:")).length, 1);
    assert.match(request.messages[0]!.content!, /Distinct first delegation/);
    let pending: string[] = [];
    for (const message of request.messages.slice(1)) {
      if (message.role === "tool") assert.equal(message.toolCallId, pending.shift());
      else {
        assert.equal(pending.length, 0);
        if (message.role === "assistant") pending = message.toolCalls?.map((call) => call.id) ?? [];
      }
    }
    assert.equal(pending.length, 0);
  }
  const beforeSecond = requests.length;
  enqueueDecision(llm, "finish_run", { status: "needs_user", message: "Need a target." });
  await agent.runDelegatedStep("Distinct second delegation.");
  const fresh = llm.requests[beforeSecond]!;
  assert.equal(fresh.messages.length, 3);
  assert.doesNotMatch(JSON.stringify(fresh.messages), /Distinct first delegation|observed_11/);
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
  enqueueMemory(llm, "Dug the dirt.");
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

test("actioner compact replay includes actual TaskResults and clears between delegations", async () => {
  const { agent, llm, executor } = createHarness({ noMemory: true, toolReplayMode: "compact" });
  enqueueDecision(llm, "set_plan", { tasks: [{ capability: "dig", input: { position: { x: 1, y: 2, z: 3 } } }] });
  enqueueDecision(llm, "continue_plan", {});
  executor.enqueue(failure("NO_PATH", "Target unreachable.", { retryable: true, facts: { distance: 8 } }));
  enqueueDecision(llm, "finish_run", { status: "failure", message: "Cannot reach target." });
  const report = await agent.runDelegatedStep("Try the observed log.");
  assert.equal(report.status, "failure");
  assert.equal(executor.started.length, 1);
  const review = llm.requests.at(-1)!.messages;
  assert.equal(review.at(-1)!.role, "tool");
  assert.match(review.at(-1)!.content!, /NO_PATH/);
  assert.match(review.at(-1)!.content!, /"distance":8/);
  assert.ok(review.some((m) => m.role === "assistant" && m.content?.includes("tool: set_plan")));
  assert.ok(review.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "continue_plan"));
  enqueueDecision(llm, "finish_run", { status: "needs_user", message: "Waiting." });
  await agent.runDelegatedStep("New delegation.");
  assert.doesNotMatch(JSON.stringify(llm.requests.at(-1)!.messages), /NO_PATH|Try the observed log/);
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

  enqueueMemory(llm, "Dig was interrupted.");
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

  enqueueMemory(llm, "Task finished, awaiting review.");
  enqueueDecision(llm, "finish_run", {
    status: "success",
    message: "Done.",
  });
  enqueueMemory(llm, "Finished after the action.");
  deferred.resolve(success({ ok: true }));
  await waitForIdle(agent);
});

test("repeated plans without an action are bounded", async () => {
  const { agent, llm, executor, replies } = createHarness({
    maxConsecutivePlansWithoutAction: 2,
  });
  enqueueIntent(llm, "action_request");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    enqueueDecision(llm, "set_plan", {
      tasks: [{ capability: "dig", input: { position: { x: 1, y: 2, z: 3 } } }],
    });
    enqueueMemory(llm, `Plan ${attempt + 1}.`);
  }
  enqueueDecision(llm, "set_plan", { tasks: [] });

  agent.submitUserMessage("owner", "dig a block");
  await waitForIdle(agent);

  assert.equal(executor.started.length, 0);
  assert.match(replies.at(-1)!, /replacing its plan without executing/);
  assert.equal(
    llm.requests.filter((request) => request.trace?.phase === "memory").length,
    2,
  );
});

test("a completed task is saved before a failed review", async () => {
  const { agent, llm, executor, workingMemory } = createHarness({
    maxResponseRetries: 1,
  });
  enqueueIntent(llm, "action_request");
  enqueueDecision(llm, "set_plan", {
    tasks: [{ capability: "dig", input: { position: { x: 1, y: 2, z: 3 } } }],
  });
  enqueueMemory(llm, "Need to dig.");
  enqueueDecision(llm, "continue_plan", {});
  enqueueMemory(llm, "Starting to dig.");
  executor.enqueue(success({ block: "dirt" }));
  enqueueMemory(llm, "Successfully dug dirt at 1,2,3.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    llm.enqueue({
      message: { role: "assistant", content: "invalid review" },
      finishReason: "stop",
    });
  }

  agent.submitUserMessage("owner", "dig that block");
  await waitForIdle(agent);

  assert.equal(executor.started.length, 1);
  assert.equal(workingMemory.read(), "Successfully dug dirt at 1,2,3.");
  const outcomeUpdate = llm.requests.find(
    (request) => request.trace?.phase === "memory" && request.trace.round === 1,
  );
  assert.ok(outcomeUpdate);
  assert.match(JSON.stringify(outcomeUpdate.trace?.contextSnapshot), /"ok":true/);
});

function createHarness(
  options: {
    maxResponseRetries?: number;
    maxConsecutivePlansWithoutAction?: number;
    noMemory?: boolean;
    toolReplayMode?: "native" | "compact";
  } = {},
): {
  agent: SequentialAgent;
  llm: FakeLLMClient;
  executor: ScriptedExecutor;
  replies: string[];
  workingMemory: WorkingMemory;
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
      conversationSummaryPrompt: PromptTemplate.fromString("conversation-summary", "Previous conversation summary: empty."),
    }),
    toolBridge: stubBridge() as unknown as AgentToolBridge,
    runner,
    workingMemory,
    ...(options.noMemory ? {} : { memoryUpdater }),
    maxToolRounds: 2,
    maxResponseRetries: options.maxResponseRetries ?? 8,
    maxConsecutivePlansWithoutAction:
      options.maxConsecutivePlansWithoutAction ?? 8,
    temperature: 0,
    maxTokens: 200,
    toolReplayMode: options.toolReplayMode,
    respond: async (message) => {
      replies.push(message);
    },
  });
  return { agent, llm, executor, replies, workingMemory };
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
    facing: "north",
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
