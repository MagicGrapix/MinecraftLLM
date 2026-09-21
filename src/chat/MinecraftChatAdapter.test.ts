import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { Agent } from "../agent/Agent";
import { FakeLLMClient } from "../llm/FakeLLMClient";
import { ChatIntentRouter } from "./ChatIntentRouter";
import {
  MinecraftChatAdapter,
  splitChatMessage,
} from "./MinecraftChatAdapter";

test("intent router handles mandatory question and action cases", async () => {
  const llm = new FakeLLMClient();
  const router = new ChatIntentRouter(llm);

  assert.equal(
    (await router.route("construis une table de craft")).kind,
    "action_request",
  );
  assert.equal(
    (
      await router.route(
        "comment tu penses construire une table de craft ?",
      )
    ).kind,
    "readonly_question",
  );
  assert.equal(
    (await router.route("est-ce que tu peux construire une table ?")).kind,
    "action_request",
  );
  assert.equal(
    (
      await router.route(
        "Peux-tu m'expliquer comment construire une table ?",
      )
    ).kind,
    "readonly_question",
  );
  assert.equal(
    (await router.route("Can you explain how to build a chest?")).kind,
    "readonly_question",
  );
  assert.equal(
    (await router.route("où est le coffre ?")).kind,
    "readonly_question",
  );
  assert.equal((await router.route("attends")).kind, "unclear");
});

test("invalid classifier output becomes unclear", async () => {
  const llm = new FakeLLMClient();
  llm.enqueue({
    message: { role: "assistant", content: "not-json" },
    finishReason: "stop",
  });
  const intent = await new ChatIntentRouter(llm).route(
    "ce truc là peut-être",
  );
  assert.equal(intent.kind, "unclear");
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
  } as unknown as Agent;
  const adapter = new MinecraftChatAdapter({
    bot,
    agent,
    ownerUsername: "owner",
    chunkDelayMs: 0,
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
