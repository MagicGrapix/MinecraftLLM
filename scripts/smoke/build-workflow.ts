import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { loadAgentConfig } from "../../src/agent/AgentConfig";
import { createAgentRuntime, type RunningAgentRuntime } from "../../src/bootstrap/createAgentRuntime";
import { parseArchitectDrawing } from "../../src/building/ArchitectDrawing";
import { BlueprintValidator } from "../../src/building/BlueprintValidator";
import { getFullTraceFilePath } from "../../src/Logger";
import type { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import { MaterialCatalog } from "../../src/world/MaterialCatalog";
import { FakeLLMClient } from "../../tests/support/FakeLLMClient";
import { enqueueBuildingWorkflow } from "../../tests/support/BuildingWorkflowScript";
import { architectDrawingFixture } from "../../tests/support/blueprints";
import { until } from "../../tests/e2e/async";

/** Called only after build.ts verifies and owns its small empty test site. No Ollama. */
export async function runBuildingWorkflowSmoke(runtime: MinecraftRuntime, observer: Bot, origin: Vec3, directory: string) {
  const drawing = await architectDrawingFixture();
  const parsed = parseArchitectDrawing(drawing.drawing);
  assert.ok(parsed.ok);
  const compiled = new BlueprintValidator(new MaterialCatalog(runtime.bot.registry)).validate(parsed.value);
  assert.ok(compiled.ok);
  const script = new FakeLLMClient();
  let running: RunningAgentRuntime | undefined;
  const stop = new AbortController();
  const onStop = () => stop.abort("Workflow smoke interrupted");
  process.on("SIGINT", onStop); process.on("SIGTERM", onStop);
  try {
    running = await createAgentRuntime(runtime, {
      ...loadAgentConfig(), landmarksFile: join(directory, "landmarks.json"),
      inspectorEnabled: true, inspectorPort: 3003, responseMaxRetries: 0,
    }, undefined, { blueprintsDirectory: directory, llm: { async complete(request) {
      assert.ok(request.trace);
      running!.inspector!.recordRequest(request.trace, { model: "scripted-fixture-no-llm", messages: request.messages, tools: request.tools ?? [] });
      const response = await script.complete(request);
      running!.inspector!.recordResponse(request.trace, response);
      return response;
    } } });
    // Direct submission isolates this test from public player/controller chat.
    running.chat.detach();
    const finish = () => until(() => (running!.agent.state() as { mode: string }).mode === "idle", 330_000, "Building workflow", stop.signal);
    enqueueBuildingWorkflow(script, drawing, origin, true);
    running.agent.submitUserMessage("smoke", "Draw a five-by-five oak house with an open entrance. Do not construct it.");
    await finish();
    const designId = running.agent.task.construction?.blueprint.blueprintId;
    assert.ok(designId);
    assert.equal(running.agent.task.steps.length, 0);
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) for (let y = 0; y < 4; y++) {
      assert.equal(observer.blockAt(origin.offset(x, y, z))?.name, "air", "Design must not construct");
    }
    const previousCalls = script.requests.length;
    enqueueBuildingWorkflow(script, drawing, origin);
    running.agent.submitUserMessage("smoke", (await readFile(resolve("tests/fixtures/prompts/build-workflow-request.md"), "utf8")).trim());
    await finish();
    assert.equal(running.agent.task.steps[0]?.status, "done", "Workflow must verify and check off its build step");
    assert.notEqual(running.agent.task.construction?.blueprint.blueprintId, designId, "New request needs a newly selected reference");
    assert.deepEqual(script.requests.slice(previousCalls).map(r => r.trace!.phase), [
      "coordinator", "architect", "coordinator", "planner", "coordinator", "actioner", "actioner", "coordinator", "coordinator",
    ]);
    await until(() => compiled.value.cells.every(cell => {
      if (cell.kind === "ignore") return true;
      const actual = observer.blockAt(origin.offset(cell.position.x, cell.position.y, cell.position.z));
      if (cell.kind === "door") return actual?.name === cell.block && Object.entries(cell.properties).every(([k, v]) => actual.getProperties()[k] === v);
      return actual?.name === (cell.kind === "block" ? cell.block : "air");
    }), 5000, "Independent observer verifies all blueprint cells", stop.signal);
    await until(() => !runtime.bot.inventory.items().some(i => ["oak_planks"].includes(i.name)), 3000, "Exact build stock consumed", stop.signal);
    assert.ok(running.isPhysicallyIdle());
    console.info("Workflow smoke passed: design-only untouched, new request, Architect → planner → actioner → verified checklist; 80 placements. Scripted LLM, real Minecraft.", { trace: getFullTraceFilePath() });
  } finally {
    process.off("SIGINT", onStop); process.off("SIGTERM", onStop);
    await running?.shutdown("Building workflow smoke finished");
  }
}
