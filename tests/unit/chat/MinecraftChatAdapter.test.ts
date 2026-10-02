import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { ChatControlledAgent } from "../../../src/chat/MinecraftChatAdapter";
import {
  MinecraftChatAdapter,
  splitChatMessage,
} from "../../../src/chat/MinecraftChatAdapter";

test("chat adapter passes messages and controls from any player", async () => {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  const received: Array<{
    username: string;
    text: string;
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
    ) => {
      received.push({ username, text });
    },
  } as unknown as ChatControlledAgent;
  const adapter = new MinecraftChatAdapter({
    bot,
    agent,
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

  assert.equal(stops, 2);
  assert.equal(resumes, 1);
  assert.deepEqual(received, [
    {
      username: "visitor",
      text: "où est le coffre ?",
    },
    { username: "owner", text: "attends" },
  ]);
  assert.deepEqual(sent, []);
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
    agent: {} as ChatControlledAgent,
    maxChunkLength: 5,
    minMessageIntervalMs: 30,
  });

  await Promise.all([adapter.send("hello world"), adapter.send("again")]);

  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[1]! - sentAt[0]! >= 25);
  assert.ok(sentAt[2]! - sentAt[1]! >= 25);
});
