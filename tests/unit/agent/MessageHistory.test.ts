import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { MessageHistory, withValidationFeedback } from "../../../src/agent/MessageHistory";

test("actioner history can reserve a third pinned instruction without changing coordinator defaults", () => {
  const action = new MessageHistory(5, 30_000, "native", 3);
  const coordinator = new MessageHistory(5);
  for (const history of [action, coordinator]) {
    history.append({ role: "assistant", content: "old" });
    history.appendExchange({ role: "assistant", content: null, toolCalls: [{ id: "a", name: "read", arguments: "{}" }] },
      [{ role: "tool", toolCallId: "a", content: "{}" }]);
  }
  assert.equal(action.snapshot().messages.length, 2);
  assert.equal(coordinator.snapshot().messages.length, 3);
  assert.throws(() => new MessageHistory(4, 30_000, "native", 3));
});

test("history evicts whole multi-tool exchanges and reserves system and summary slots", () => {
  const history = new MessageHistory(6);
  history.append({ role: "user", content: "initial" });
  history.appendExchange({ role: "assistant", content: null, toolCalls: [
    { id: "a", name: "read", arguments: "{}" }, { id: "b", name: "read", arguments: "{}" },
  ] }, [{ role: "tool", toolCallId: "a", content: "{}" }, { role: "tool", toolCallId: "b", content: "{}" }]);
  history.append({ role: "user", content: "latest" });
  assert.deepEqual(history.snapshot().messages.map((m) => m.role), ["assistant", "tool", "tool", "user"]);
  history.append({ role: "assistant", content: "answer" });
  assert.deepEqual(history.snapshot().messages.map((m) => m.content), ["latest", "answer"]);
  assert.equal(history.snapshot().omitted, 4);
});

test("oversized groups are evicted whole, never chopping JSON or leaving orphan results", () => {
  const history = new MessageHistory(20, 200);
  history.append({ role: "user", content: "old" });
  history.appendExchange({ role: "assistant", content: null, toolCalls: [{ id: "a", name: "read", arguments: "{}" }] },
    [{ role: "tool", toolCallId: "a", content: JSON.stringify({ data: "x".repeat(300) }) }]);
  assert.deepEqual(history.snapshot().messages, []);
  assert.equal(history.snapshot().omitted, 3);
  history.clear();
  assert.equal(history.snapshot().omitted, 0);
});

test("history rejects malformed exchanges and retry feedback is internal", () => {
  const history = new MessageHistory();
  assert.throws(() => history.append({ role: "tool", toolCallId: "missing", content: "{}" }));
  assert.throws(() => history.appendExchange({ role: "assistant", content: null, toolCalls: [{ id: "a", name: "read", arguments: "{}" }] }, []));
  const messages = withValidationFeedback([{ role: "system", content: "rules" }, { role: "user", content: "question" }], "Invalid field");
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.content, "question");
  assert.match(messages[0]!.content!, /Invalid field/);
});

test("native and compact tool results round presentation but keep original calls exact", () => {
  for (const mode of ["native", "compact"] as const) {
    const history = new MessageHistory(20, 30_000, mode);
    const args = { position: { x: 10.53869625851037, y: -60, z: 4 } };
    const raw = { ok: true, value: { ...args, health: 14.833333969116211, count: 1 } };
    const response = { role: "assistant" as const, content: null, toolCalls: [{ id: "a", name: "get_self", arguments: JSON.stringify(args) }] };
    const result = { role: "tool" as const, toolCallId: "a", content: JSON.stringify(raw) };
    const before = structuredClone({ response, result });
    history.appendExchange(response, [result]);
    const native = JSON.parse(history.snapshot().messages.at(-1)!.content!);
    assert.equal(native.value.position.x, 10.54);
    assert.equal(native.value.health, 14.83);
    assert.equal(native.value.count, 1);
    const inventory = { ok: true, value: { items: [{ name: "oak_log", count: 1 }] } };
    history.appendExchange({ role: "assistant", content: null, toolCalls: [{ id: "s", name: "get_inventory", arguments: "{}" }] }, [{ role: "tool", toolCallId: "s", content: JSON.stringify(inventory) }]);
    assert.deepEqual(JSON.parse(history.snapshot().messages.at(-1)!.content!), inventory);
    if (mode === "compact") {
      const older = parse(history.snapshot().messages[0]!.content!.split("\n").slice(1).join("\n"));
      assert.equal(older.arguments.position.x, 10.54);
      assert.equal(older.result.value.position.x, 10.54);
    }
    assert.deepEqual({ response, result }, before);
  }
});

test("compact replay keeps the latest exchange native and preserves older arguments and results", () => {
  const history = new MessageHistory(20, 30_000, "compact");
  const args = { position: { x: -2.5, y: -60, z: 3 }, expected: "oak_log" };
  const result = { ok: false, error: { code: "NO_PATH", message: "Cannot reach target.\nGround is missing.", facts: { partial: true } } };
  const inventory = { items: [{ name: "oak_log", count: 1 }] };
  const response = { role: "assistant" as const, content: null, toolCalls: [
    { id: "a", name: "get_block", arguments: JSON.stringify(args) },
    { id: "b", name: "get_inventory", arguments: "{}" },
  ] };
  const results = [
    { role: "tool" as const, toolCallId: "a", content: JSON.stringify(result) },
    { role: "tool" as const, toolCallId: "b", content: JSON.stringify({ ok: true, value: inventory }) },
  ];
  const before = structuredClone({ response, results });
  history.appendExchange(response, results);
  assert.deepEqual(history.snapshot().messages.map((message) => message.role), ["assistant", "tool", "tool"]);
  history.append({ role: "assistant", content: "Next turn." });
  const messages = history.snapshot().messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "assistant");
  assert.equal("toolCalls" in messages[0]!, false);
  assert.match(messages[0]!.content!, /^Tool activity \(application record, not a player message\):/);
  assert.deepEqual(parse(messages[0]!.content!.split("\n").slice(1).join("\n")), [
    { tool: "get_block", arguments: args, result },
    { tool: "get_inventory", result: { ok: true, value: inventory } },
  ]);
  assert.deepEqual({ response, results }, before);
});

test("compact replies become plain assistant text only when sending succeeded", () => {
  for (const sent of [true, false]) {
    const history = new MessageHistory(20, 30_000, "compact");
    history.appendExchange({ role: "assistant", content: null, toolCalls: [
      { id: "r", name: "reply", arguments: '{"message":"Hello player!","outcome":"answer"}' },
    ] }, [{ role: "tool", toolCallId: "r", content: JSON.stringify(sent ? { ok: true, value: { sent: true, outcome: "answer" } } : { ok: false, error: { message: "Send failed" } }) }]);
    assert.deepEqual(history.snapshot().messages.map((message) => message.role), ["assistant", "tool"]);
    history.append({ role: "user", content: "Next request." });
    const message = history.snapshot().messages[0]!;
    if (sent) assert.deepEqual(message, { role: "assistant", content: "Hello player!" });
    else {
      assert.match(message.content!, /Tool activity/);
      assert.match(message.content!, /ok: false/);
      assert.match(message.content!, /Send failed/);
    }
  }
});

test("compact history keeps raw text results and budgets whole formatted exchanges", () => {
  const history = new MessageHistory(6, 1_000, "compact");
  const appendRead = (text: string) => history.appendExchange({ role: "assistant", content: null, toolCalls: [
    { id: "r", name: "read", arguments: "{}" },
  ] }, [{ role: "tool", toolCallId: "r", content: text }]);
  history.append({ role: "user", content: "old" });
  appendRead("Unstructured result\nKeep this exact line.");
  assert.equal(history.snapshot().messages.at(-1)?.role, "tool");
  appendRead("Latest");
  const compact = history.snapshot().messages[1]!.content!;
  assert.equal(parse(compact.split("\n").slice(1).join("\n")).result, "Unstructured result\nKeep this exact line.");
  appendRead("Another");
  assert.equal(history.snapshot().messages.length, 4);
  assert.equal(history.snapshot().omitted, 1);
  appendRead("x".repeat(2_000));
  assert.deepEqual(history.snapshot().messages, []);
  assert.throws(() => history.appendExchange({ role: "assistant", content: null, toolCalls: [{ id: "missing", name: "read", arguments: "{}" }] }, []));
});
