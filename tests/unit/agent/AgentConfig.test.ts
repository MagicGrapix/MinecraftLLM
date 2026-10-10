import assert from "node:assert/strict";
import test from "node:test";
import { LLM_BACKEND, loadAgentConfig } from "../../../src/agent/AgentConfig";

test("runtime defaults keep completion and compression budgets separate", () => {
  assert.equal(loadAgentConfig({}).llmMaxTokens, 4096);
  assert.equal(loadAgentConfig({}).responseMaxRetries, 8);
});

test("shared LLM configuration follows the backend selected in the code", () => {
  const config = loadAgentConfig({});
  const expected = LLM_BACKEND === "llamacpp"
    ? ["http://127.0.0.1:8080/v1", "local", "qwen27b"]
    : ["http://localhost:11434/v1", "ollama", "qwen3.5:9b"];
  assert.deepEqual([config.llmBaseUrl, config.llmApiKey, config.llmModel], expected);
});

test("explicit connection overrides still take precedence over the selected backend", () => {
  const config = loadAgentConfig({
    LLM_BASE_URL: "http://localhost:11434/v1",
    LLM_API_KEY: "ollama",
    LLM_MODEL: "qwen3.5:9b",
  });
  assert.equal(config.llmBaseUrl, "http://localhost:11434/v1");
  assert.equal(config.llmApiKey, "ollama");
  assert.equal(config.llmModel, "qwen3.5:9b");
});
