import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { MineflayerCommandTransport } from "../../../src/devworld/controller/MineflayerCommandTransport";

test("server command refusal is reported, unrelated player chat is not", async () => {
  const bot = Object.assign(new EventEmitter(), { chat: (_text: string) => undefined });
  const transport = new MineflayerCommandTransport(bot as unknown as Bot, 1, () => 0, async () => {
    bot.emit("messagestr", "Player says error", "chat", { color: "red" });
    bot.emit("messagestr", "Outside world", "system", { json: { color: "red", translate: "argument.pos.outofworld" } });
  });
  const result = await transport.send("fill 0 -96 0 1 -95 1 air");
  assert.equal(result.error, "Outside world");
  assert.deepEqual(result.responses, ["Outside world"]);
  transport.close();
  assert.equal(bot.listenerCount("messagestr"), 0);
});
test("expected reset no-ops do not interrupt the remaining reset commands", async () => {
  for (const [command, translate] of [
    ["kill @e[type=!minecraft:player]", "argument.entity.notfound.entity"],
    ["clear bot", "clear.failed.single"],
    ["effect clear bot", "commands.effect.clear.everything.failed"],
    ["fill 0 0 0 1 1 1 air", "commands.fill.failed"],
  ]) {
    const bot = Object.assign(new EventEmitter(), { chat: () => undefined });
    const transport = new MineflayerCommandTransport(bot as unknown as Bot, 1, () => 0, async () => {
      bot.emit("messagestr", "Nothing changed", "system", { color: "red", translate });
    });
    assert.equal((await transport.send(command!)).error, undefined);
    transport.close();
  }
});
test("no feedback means sent, not independently verified", async () => {
  const bot = Object.assign(new EventEmitter(), { chat: () => undefined });
  const transport = new MineflayerCommandTransport(bot as unknown as Bot, 0);
  assert.deepEqual((await transport.send("time set day")).responses, []);
  transport.close();
});
