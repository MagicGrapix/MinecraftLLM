import assert from "node:assert/strict";
import type { ActionDelegation } from "../../src/agent/ActionTypes";
import type { LLMResponse } from "../../src/llm/LLMClient";
import type { Position } from "../../src/shared/types";
import { FakeLLMClient } from "./FakeLLMClient";

/** Transport double only: tools, validation, storage, execution and handoffs stay real. */
export function enqueueBuildingWorkflow(llm: FakeLLMClient, drawing: { drawing: string }, origin: Position, designOnly = false): void {
  const tool = (name: string, args: unknown): LLMResponse => ({ message: {
    role: "assistant", content: null, toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }],
  }, finishReason: "tool_calls" });
  llm.enqueue(tool("ask_architect", { instruction: "Prepare the five-by-five reference oak house with an open entrance." }));
  llm.enqueue(request => {
    assert.equal(request.trace?.phase, "architect");
    assert.deepEqual(request.tools!.map(t => t.name), ["submit_blueprint"]);
    return tool("submit_blueprint", drawing);
  });
  llm.enqueue(request => {
    const accepted = JSON.parse(request.messages.at(-1)!.content!);
    assert.ok(accepted.ok && accepted.value.blueprintId, "Architect must actually save a valid blueprint");
    return designOnly ? tool("reply", { outcome: "answer", message: "Design saved. Nothing built." })
      : tool("ask_planner", { instruction: `Build the selected blueprint at (${origin.x}, ${origin.y}, ${origin.z}); stock is supplied.` });
  });
  if (designOnly) return;
  llm.enqueue(request => {
    assert.equal(request.trace?.phase, "planner");
    assert.deepEqual(request.tools!.map(t => t.name), ["search_recipes", "read_recipe", "submit_plan"]);
    assert.match(request.messages[0]!.content!, /oak_planks x80/);
    return tool("submit_plan", { steps: [{ title: "Build house", successCriteria: "Blueprint cells verified correct at the supplied origin." }] });
  });
  llm.enqueue(tool("run_step", { step: 1, instruction: "Build the selected house at the supplied observed origin and verify it." }));
  llm.enqueue(request => {
    assert.equal(request.trace?.phase, "actioner");
    const d = (request.trace!.contextSnapshot as { delegation: ActionDelegation }).delegation;
    assert.ok(d.construction);
    return tool("build", { blueprintId: d.construction.blueprint.blueprintId, origin });
  });
  llm.enqueue(request => {
    const result = JSON.parse(request.messages.at(-1)!.content!);
    assert.equal(result.ok, true, JSON.stringify(result));
    return tool("finish_step", { status: "success", message: "Build returned success after checking every required cell and leaving the footprint." });
  });
  llm.enqueue(request => {
    assert.equal(request.trace?.phase, "coordinator");
    const result = JSON.parse(request.messages.at(-1)!.content!);
    assert.equal(result.value.report.status, "success");
    return tool("complete_step", { step: 1 });
  });
  llm.enqueue(tool("reply", { outcome: "success", message: "House built and verified." }));
}
