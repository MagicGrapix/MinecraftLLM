import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DelegatedActionReport, SequentialAgent } from "../../../src/agent/SequentialAgent";
import { WorkflowAgent } from "../../../src/agent/WorkflowAgent";
import { ConversationHistory, WorkflowSummaryFile } from "../../../src/agent/WorkflowState";
import { success } from "../../../src/execution/TaskResult";
import { FakeLLMClient } from "../../../src/llm/FakeLLMClient";
import type { LandmarkMemory } from "../../../src/memory/LandmarkMemory";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import type { WorldQueries } from "../../../src/world/WorldQueries";

test("coordinator answers with conversation history and no intent classifier call", async () => {
  const harness = await createHarness();
  try {
    enqueue(harness.llm, {
      next: "reply", summary: "The user asked about inventory.", completedStepIds: [],
      outcome: "answer", message: "You have one oak log.",
    });
    harness.agent.submitUserMessage("owner", "What is in my inventory?");
    await waitForIdle(harness.agent);

    assert.deepEqual(harness.replies, ["You have one oak log."]);
    assert.equal(harness.llm.requests.length, 1);
    assert.equal(harness.llm.requests[0]?.trace?.phase, "coordinator");
    const messages = harness.llm.requests[0]!.messages;
    assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
    assert.equal(messages[1]?.content, "What is in my inventory?");
    const context = systemContext(messages[0]?.content);
    assert.equal(context.source, "minecraft_runtime_context");
    assert.equal(context.historyOmitted, 0);
    assert.equal("objective" in context.task, false);
    assert.equal("capabilities" in context, false);
    assert.equal(harness.llm.requests[0]?.tools, undefined);
    assert.equal(harness.agent.history.all().length, 2);
    assert.match(await readFile(harness.summary.path, "utf8"), /The user asked about inventory/);
  } finally {
    await harness.close();
  }
});

test("coordinator replays at most ten previous chat messages with their roles", async () => {
  const harness = await createHarness();
  try {
    for (let index = 1; index <= 7; index += 1) {
      enqueue(harness.llm, {
        next: "reply", summary: `Answered question ${index}.`, completedStepIds: [],
        outcome: "answer", message: `Answer ${index}.`,
      });
      harness.agent.submitUserMessage("owner", `Question ${index}?`);
      await waitForIdle(harness.agent);
    }

    const messages = harness.llm.requests[6]!.messages;
    assert.equal(messages.length, 12);
    assert.equal(messages[0]?.role, "system");
    assert.deepEqual(messages.slice(1, -1).map((message) => message.role), [
      "user", "assistant", "user", "assistant", "user", "assistant",
      "user", "assistant", "user", "assistant",
    ]);
    assert.equal(messages[1]?.content, "Question 2?");
    assert.equal(messages[10]?.content, "Answer 6.");
    const context = systemContext(messages[0]?.content);
    assert.equal(context.historyOmitted, 2);
    assert.equal(messages[11]?.content, "Question 7?");
    assert.equal(messages.slice(1, -1).some((message) => message.content === "Question 7?"), false);
  } finally {
    await harness.close();
  }
});

test("conversation replay respects the character budget before the active request", () => {
  const history = new ConversationHistory();
  history.append("user", "Old question");
  history.append("assistant", "Recent answer");
  history.append("user", "Current request");
  const budget = JSON.stringify(history.all()[1]).length;
  const selected = history.forPrompt(budget, 10, true);
  assert.deepEqual(selected.entries.map((entry) => entry.text), ["Recent answer"]);
  assert.equal(selected.omitted, 1);
});

test("planner is single-shot and the coordinator checks the action report before marking a step", async () => {
  const harness = await createHarness();
  try {
    enqueue(harness.llm, {
      next: "plan", summary: "Need wood.", completedStepIds: [],
      instruction: "Plan how to collect one oak log.",
    });
    enqueue(harness.llm, {
      steps: [{ id: "collect_log", title: "Collect a log", successCriteria: "Inventory contains an oak log." }],
    });
    enqueue(harness.llm, {
      next: "act", summary: "The plan is ready.", completedStepIds: [],
      stepId: "collect_log", instruction: "Collect one oak log.",
    });
    enqueue(harness.llm, {
      next: "reply", summary: "One oak log was collected.",
      completedStepIds: ["collect_log"], outcome: "success", message: "I collected a log.",
    });
    harness.actions.push({
      status: "success", message: "Inventory now contains an oak log.",
      outcomes: [{
        task: { id: "dig-1", createdAt: 0, capability: "dig", input: { position: { x: 3, y: 4, z: 5 } } },
        result: success({ block: "oak_log" }),
      }],
    });

    harness.agent.submitUserMessage("owner", "Collect a log.");
    await waitForIdle(harness.agent);

    assert.deepEqual(harness.llm.requests.map((request) => request.trace?.phase), [
      "coordinator", "planner", "coordinator", "coordinator",
    ]);
    assert.equal(harness.llm.requests[1]?.messages.at(-1)?.content, "Collect a log.");
    assert.match(String(harness.llm.requests[3]?.messages[0]?.content), /dig-1/);
    assert.equal(harness.llm.requests[1]?.tools, undefined);
    assert.equal(harness.actionInstructions.length, 1);
    assert.equal(harness.agent.task.steps[0]?.status, "done");
    assert.match(await readFile(harness.summary.path, "utf8"), /- \[x\] Collect a log/);
    assert.deepEqual(harness.replies, ["I collected a log."]);
  } finally {
    await harness.close();
  }
});

test("structured retry is internal feedback and preserves the player's final request", async () => {
  const harness = await createHarness(1);
  try {
    enqueue(harness.llm, {
      next: "reply", summary: "", completedStepIds: [], message: "Hello!",
    });
    enqueue(harness.llm, {
      next: "reply", summary: "", completedStepIds: [], outcome: "answer", message: "Hello!",
    });
    harness.agent.submitUserMessage("owner", "Hello, how are you?");
    await waitForIdle(harness.agent);

    const first = harness.llm.requests[0]!.messages;
    const retry = harness.llm.requests[1]!.messages;
    assert.deepEqual(first.map((message) => message.role), ["system", "user"]);
    assert.deepEqual(retry.map((message) => message.role), ["system", "system", "user"]);
    assert.match(String(retry[1]?.content), /Internal validation feedback.*outcome: Required/);
    assert.equal(retry.at(-1)?.content, "Hello, how are you?");
    assert.deepEqual(harness.replies, ["Hello!"]);
  } finally {
    await harness.close();
  }
});

test("a failed action cannot be checked off by the coordinator", async () => {
  const harness = await createHarness();
  try {
    enqueue(harness.llm, {
      next: "act", summary: "Trying a simple step.", completedStepIds: [],
      newStep: { id: "move", title: "Move east", successCriteria: "Bot is east of spawn." },
      instruction: "Move east.",
    });
    enqueue(harness.llm, {
      next: "reply", summary: "Movement failed.", completedStepIds: ["move"],
      outcome: "failure", message: "I could not find a path.",
    });
    harness.actions.push({ status: "failure", message: "NO_PATH", outcomes: [] });

    harness.agent.submitUserMessage("owner", "Move east.");
    await waitForIdle(harness.agent);

    assert.equal(harness.agent.task.steps[0]?.status, "blocked");
    assert.match(await readFile(harness.summary.path, "utf8"), /- \[ \] Move east/);
  } finally {
    await harness.close();
  }
});

test("stop aborts the current thought and resume starts a fresh coordinator call", async () => {
  const harness = await createHarness();
  try {
    harness.llm.enqueueDeferred();
    harness.agent.submitUserMessage("owner", "Where is the tree?");
    for (let index = 0; index < 100 && harness.llm.requests.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(harness.llm.requests.length, 1);
    await harness.agent.requestStop("owner");
    assert.equal((harness.agent.state() as { mode: string }).mode, "stopped");

    enqueue(harness.llm, {
      next: "reply", summary: "A tree has not been located yet.", completedStepIds: [],
      outcome: "answer", message: "I do not know where the tree is yet.",
    });
    harness.agent.requestResume("owner");
    await waitForIdle(harness.agent);

    assert.equal(harness.llm.requests.length, 2);
    assert.equal(harness.agent.history.all().filter((entry) => entry.role === "user").length, 1);
    assert.equal(harness.replies.at(-1), "I do not know where the tree is yet.");
  } finally {
    await harness.close();
  }
});

async function createHarness(maxRetries = 0) {
  const root = await mkdtemp(join(tmpdir(), "minecraft-workflow-test-"));
  const llm = new FakeLLMClient();
  const replies: string[] = [];
  const actions: DelegatedActionReport[] = [];
  const actionInstructions: string[] = [];
  const actionAgent = {
    state: () => ({ mode: "idle" }),
    runDelegatedStep: async (instruction: string) => {
      actionInstructions.push(instruction);
      const report = actions.shift();
      if (!report) throw new Error("No scripted action report.");
      return report;
    },
    requestStop: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as SequentialAgent;
  const world = {
    getSelf: () => ({ position: { x: 0, y: 0, z: 0 }, facing: "north", health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20, onGround: true }),
    getInventory: () => ({ items: [], selectedItem: null }),
  } as unknown as WorldQueries;
  const summary = new WorkflowSummaryFile("test", root);
  const agent = new WorkflowAgent({
    llm, actionAgent, world,
    landmarks: { pinned: () => [] } as unknown as LandmarkMemory,
    prompts: {
      coordinator: PromptTemplate.fromString("coordinator", "Coordinator\n{{runtime_context}}"),
      planner: PromptTemplate.fromString("planner", "Planner\n{{runtime_context}}"),
      actioner: PromptTemplate.fromString("actioner", "Actioner {{current_context}}"),
    },
    temperature: 0,
    maxTokens: 1024,
    maxRetries,
    historyMaxChars: 10_000,
    summaryFile: summary,
    respond: async (message) => { replies.push(message); },
  });
  return {
    agent, llm, replies, actions, actionInstructions, summary,
    close: async () => { await agent.shutdown(); await rm(root, { recursive: true, force: true }); },
  };
}

function systemContext(content: unknown): any {
  const text = String(content);
  const start = text.indexOf("\n{");
  assert.notEqual(start, -1);
  return JSON.parse(text.slice(start + 1));
}

function enqueue(llm: FakeLLMClient, value: unknown): void {
  llm.enqueue({ message: { role: "assistant", content: JSON.stringify(value) }, finishReason: "stop" });
}

async function waitForIdle(agent: WorkflowAgent): Promise<void> {
  await waitForMode(agent, "idle");
}

async function waitForMode(agent: WorkflowAgent, mode: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if ((agent.state() as { mode: string }).mode === mode) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Workflow did not reach ${mode}.`);
}
