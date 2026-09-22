import assert from "node:assert/strict";
import test from "node:test";
import { ConversationHistory } from "../../../src/memory/ConversationHistory";
import { RecentActivityBuffer } from "../../../src/memory/RecentActivityBuffer";

test("recent activity is a defensive ring buffer limited to 15", () => {
  let id = 0;
  const buffer = new RecentActivityBuffer(
    15,
    () => String(++id),
    () => 123,
  );
  for (let index = 0; index < 20; index += 1) {
    buffer.add({
      kind: "task",
      summary: `entry-${index}`,
      data: { index },
    });
  }

  const entries = buffer.list();
  assert.equal(entries.length, 15);
  assert.equal(entries[0]?.summary, "entry-5");
  (entries[0]!.data as { index: number }).index = 999;
  assert.deepEqual(buffer.list()[0]?.data, { index: 5 });
});

test("conversation history evicts whole tool protocol turns", () => {
  const history = new ConversationHistory(1, 10_000);
  history.appendTurn([
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "get_self", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "call-1", content: '{"ok":true}' },
    { role: "assistant", content: "done" },
  ]);
  history.appendTurn([
    { role: "user", content: "second" },
    { role: "assistant", content: "answer" },
  ]);

  assert.deepEqual(history.messages(), [
    { role: "user", content: "second" },
    { role: "assistant", content: "answer" },
  ]);
  assert.throws(
    () =>
      history.appendTurn([
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "orphan", name: "get_self", arguments: "{}" },
          ],
        },
      ]),
    /missing tool results/,
  );
});
