import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentConfig } from "../../../src/agent/AgentConfig";

test("history configuration reserves three pinned actioner messages and a complete tool exchange", () => {
  assert.equal(loadAgentConfig({}).historyMaxMessages, 20);
  assert.equal(loadAgentConfig({ AGENT_HISTORY_MAX_MESSAGES: "5" }).historyMaxMessages, 5);
  assert.throws(() => loadAgentConfig({ AGENT_HISTORY_MAX_MESSAGES: "4" }));
});
