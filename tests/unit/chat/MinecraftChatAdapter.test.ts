import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { SequentialAgent } from "../../../src/agent/SequentialAgent";
import { FakeLLMClient } from "../../../src/llm/FakeLLMClient";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { ChatIntentRouter } from "../../../src/chat/ChatIntentRouter";
import {
  MinecraftChatAdapter,
  splitChatMessage,
} from "../../../src/chat/MinecraftChatAdapter";

const TEST_INTENT_PROMPT = PromptTemplate.fromString(
  "intent-test",
  "Classify the message as JSON.",
);

test("intent router uses the LLM for question and action cases", async () => {
  const llm = new FakeLLMClient();
  const router = new ChatIntentRouter(llm, TEST_INTENT_PROMPT);
  const cases = [
    ["construis une table de craft", "action_request"],
    [
      "comment tu penses construire une table de craft ?",
      "readonly_question",
    ],
    ["est-ce que tu peux construire une table ?", "action_request"],
    [
      "Peux-tu m'expliquer comment construire une table ?",
      "readonly_question",
    ],
    ["Can you explain how to build a chest?", "readonly_question"],
    ["où est le coffre ?", "readonly_question"],
    ["attends", "unclear"],
  ] as const;

  for (const [message, expectedKind] of cases) {
    enqueueIntent(llm, expectedKind, expectedKind === "unclear" ? 4 : 5);
    assert.equal((await router.route(message)).kind, expectedKind);
  }

  assert.equal(llm.requests.length, cases.length);
  assert.equal(
    llm.requests.every(
      (request) => request.responseFormat === "json_object",
    ),
    true,
  );
  assert.equal(
    llm.requests.every((request) => request.reasoningEffort === "none"),
    true,
  );
});

test("invalid classifier output becomes unclear", async () => {
  const llm = new FakeLLMClient();
  llm.enqueue({
    message: { role: "assistant", content: "not-json" },
    finishReason: "stop",
  });
  const intent = await new ChatIntentRouter(
    llm,
    TEST_INTENT_PROMPT,
  ).route("ce truc là peut-être");
  assert.deepEqual(intent, { kind: "unclear", confidence: 1 });
});

test("low classifier confidence becomes unclear on the five-point scale", async () => {
  const llm = new FakeLLMClient();
  enqueueIntent(llm, "action_request", 2);

  const intent = await new ChatIntentRouter(
    llm,
    TEST_INTENT_PROMPT,
  ).route("peut-être fais quelque chose");

  assert.deepEqual(intent, { kind: "unclear", confidence: 2 });
});

test("chat adapter reserves controls and mutations for the owner", async () => {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  const received: Array<{
    username: string;
    text: string;
    readonlyOnly: boolean;
  }> = [];
  let stops = 0;
  let resumes = 0;
  const bot = Object.assign(emitter, {
    username: "bot",
    chat: (message: string) => sent.push(message),
  }) as unknown as Bot;
  const agent = {
    requestStop: async () => {
      stops += 1;
    },
    requestResume: () => {
      resumes += 1;
    },
    submitUserMessage: (
      username: string,
      text: string,
      readonlyOnly: boolean,
    ) => {
      received.push({ username, text, readonlyOnly });
    },
  } as unknown as SequentialAgent;
  const adapter = new MinecraftChatAdapter({
    bot,
    agent,
    ownerUsername: "owner",
    minMessageIntervalMs: 0,
  });
  adapter.attach();

  emitter.emit("chat", "bot", "hello");
  emitter.emit("chat", "visitor", "stop");
  emitter.emit("chat", "owner", " BOT   STOP ");
  emitter.emit("chat", "owner", "resume");
  emitter.emit("chat", "visitor", "où est le coffre ?");
  emitter.emit("chat", "owner", "attends");
  await Promise.resolve();

  assert.equal(stops, 1);
  assert.equal(resumes, 1);
  assert.deepEqual(received, [
    {
      username: "visitor",
      text: "où est le coffre ?",
      readonlyOnly: true,
    },
    { username: "owner", text: "attends", readonlyOnly: false },
  ]);
  assert.deepEqual(sent, ["Commande réservée au propriétaire."]);
  adapter.detach();
});

test("chat responses are split without oversized chunks", () => {
  const chunks = splitChatMessage("a".repeat(450), 100);
  assert.equal(chunks.length, 5);
  assert.equal(chunks.every((chunk) => chunk.length <= 100), true);
});

test("all outgoing chat messages share the same rate limit", async () => {
  const sentAt: number[] = [];
  const bot = {
    username: "bot",
    chat: () => sentAt.push(Date.now()),
  } as unknown as Bot;
  const adapter = new MinecraftChatAdapter({
    bot,
    agent: {} as SequentialAgent,
    ownerUsername: "owner",
    maxChunkLength: 5,
    minMessageIntervalMs: 30,
  });

  await Promise.all([adapter.send("hello world"), adapter.send("again")]);

  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[1]! - sentAt[0]! >= 25);
  assert.ok(sentAt[2]! - sentAt[1]! >= 25);
});

function enqueueIntent(
  llm: FakeLLMClient,
  kind:
    | "readonly_question"
    | "action_request"
    | "conversation"
    | "unclear",
  confidence: number,
): void {
  llm.enqueue({
    message: {
      role: "assistant",
      content: JSON.stringify({ kind, confidence }),
    },
    finishReason: "stop",
  });
}
