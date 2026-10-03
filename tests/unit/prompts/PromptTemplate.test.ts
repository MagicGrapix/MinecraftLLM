import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadWorkflowPrompts } from "../../../src/prompts/WorkflowPrompts";
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
  const prompts = await loadWorkflowPrompts(resolve(process.cwd(), "prompts"));

  const system = prompts.actioner.render({
    task_context: "Delegated step 1: collect wood.",
    task_summary_section: "",
    world_context: "Inventory: empty.",
  });
  assert.ok(system.length > 0);
  assert.match(system, /finish_step/);
  assert.doesNotMatch(system, /finish_run/);
  assert.match(system, /Delegated step 1: collect wood/);
  assert.doesNotMatch(system, /{{\s*\w+\s*}}/); // Editable prose is not an exact-string contract.
  assert.doesNotMatch(system, /## Last Action Result|## Local Plan|## Available Capabilities|set_plan|continue_plan|get_capability_schemas/);
  const values = { task_context: "No plan yet.", task_summary_section: "", world_context: "Inventory: empty." };
  const coordinator = prompts.coordinator.render(values);
  assert.match(coordinator, /ONE native tool call/);
  assert.match(coordinator, /## Task Context\s+No plan yet\.\s+## World Context/);
  assert.doesNotMatch(coordinator, /## Instruction|## Task Summary|task\.objective|runtime_context/);
  const planner = prompts.planner.render({ ...values, instruction: "Plan one log collection.", action_tools: "### dig\nBreak one block." });
  assert.match(planner, /Reply with exactly one JSON object/);
  assert.match(planner, /"steps":\[\{"title":/);
  assert.match(planner, /## Instruction\s+Plan one log collection\./);
  assert.match(planner, /### dig\s+Break one block\./);
  assert.doesNotMatch(planner, /{{\s*\w+\s*}}/);
  assert.doesNotMatch(planner, /task\.objective|runtime_context/);
  assert.match(system, /## World Context\s+Current snapshot/);
  assert.doesNotMatch(system, /```/);
  assert.match(prompts.conversationSummary.render({ summary: "empty." }), /Previous conversation summary: empty/);
  assert.match(
    prompts.summary.render({
      max_chars: 500,
      summary_input: { oldMemory: "Crafted planks." },
    }),
    /500/,
  );
});
