import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadAgentPrompts } from "../../../src/prompts/AgentPrompts";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";

test("prompt templates inject named values", () => {
  const prompt = PromptTemplate.fromString(
    "test",
    "State={{state}}\nRevision={{revision}}",
  );

  assert.equal(
    prompt.render({ state: { mode: "paused" }, revision: 7 }),
    'State={"mode":"paused"}\nRevision=7',
  );
});

test("prompt templates reject missing and undefined values", () => {
  const prompt = PromptTemplate.fromString("test", "Hello {{name}}");

  assert.throws(() => prompt.render(), /missing value "name"/);
  assert.throws(
    () => prompt.render({ name: undefined }),
    /is undefined/,
  );
});

test("all runtime agent prompts load from Markdown and render", async () => {
  const prompts = await loadAgentPrompts(resolve(process.cwd(), "prompts"));

  const system = prompts.system.render({
    current_context: '{"mode":"idle"}',
  });
  assert.match(system, /Minecraft Agent/);
  assert.match(system, /"mode":"idle"/);
  assert.match(prompts.intentClassifier.render(), /1 to 5/);
  assert.match(
    prompts.memoryUpdate.render({
      max_chars: 500,
      memory_input: { oldMemory: "Crafted planks." },
    }),
    /500/,
  );
});
