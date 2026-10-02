import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentConfig } from "../../../src/agent/AgentConfig";

test("runtime defaults keep completion and compression budgets separate", () => {
  assert.equal(loadAgentConfig({}).llmMaxTokens, 4096);
  assert.equal(loadAgentConfig({}).responseMaxRetries, 8);
});
