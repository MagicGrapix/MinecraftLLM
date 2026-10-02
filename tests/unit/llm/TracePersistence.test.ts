import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("default logging persists malformed responses and finalized rounds beyond process lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minecraft-trace-test-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, LOG_DIR: directory };
    delete env.LOG_FULL_TRACE;
    const child = spawnSync(process.execPath, ["-r", "ts-node/register", "-e", `
      require("./src/Logger");
      const { AgentInspector } = require("./src/debug/AgentInspector");
      const { OpenAICompatibleLLMClient } = require("./src/llm/OpenAICompatibleLLMClient");
      const inspector = new AgentInspector();
      const trace = { generationId: 1, phase: "coordinator", reflection: 1, round: 0, attempt: 0, wakeType: "test", permission: "coordination" };
      const client = new OpenAICompatibleLLMClient({ baseUrl: "http://localhost:11434/v1", apiKey: "must-not-be-logged", model: "test", requestTimeoutMs: 1000, inspector }, {
        create: async () => ({ choices: [{ message: { content: null }, finish_reason: "length" }], usage: { completion_tokens: 4096 } })
      });
      client.complete({ messages: [{ role: "user", content: "Test" }], trace })
        .catch(() => inspector.finalizeRound(trace, "invalid_response"));
    `], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    const file = (await readdir(directory)).find((name) => name.startsWith("trace_"))!;
    assert.ok(file);
    const content = await readFile(join(directory, file), "utf8");
    const events = content.trim().split("\n").map((line) => JSON.parse(line));
    for (const event of ["llm.request", "llm.raw_response", "llm.error", "inspector.round"]) assert.ok(events.some((entry) => entry.event === event));
    assert.match(content, /completion_tokens.*4096/);
    assert.doesNotMatch(content, /must-not-be-logged/);
    const snapshot = events.find((entry) => entry.event === "inspector.round").data;
    assert.equal(snapshot.rawResponse.choices[0].finish_reason, "length");
    assert.equal(snapshot.status, "invalid_response");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
