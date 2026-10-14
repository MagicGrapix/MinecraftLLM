import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { loadAgentConfig } from "../../src/agent/AgentConfig";
import { createAgentRuntime, type RunningAgentRuntime } from "../../src/bootstrap/createAgentRuntime";
import { BlueprintStore } from "../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../src/building/BlueprintValidator";
import { OpenAICompatibleLLMClient } from "../../src/llm/OpenAICompatibleLLMClient";
import type { MinecraftRuntime } from "../../src/runtime/MinecraftRuntime";
import { MaterialCatalog } from "../../src/world/MaterialCatalog";
import { subscribeTrace, writeTrace } from "../../src/TraceLog";
import { until } from "../../tests/e2e/async";
import { cleanupSteps } from "../../src/runtime/cleanup";

/** Real configured LLM. Caller owns the source fixture and empty construction site. */
export async function collectionWorkflow(runtime: MinecraftRuntime, observer: Bot, origin: Vec3,
  directory: string, inventory: () => Promise<Record<string, number>>, clearInventory: () => Promise<void>) {
  const config = loadAgentConfig(), started = performance.now();
  const store = new BlueprintStore(new BlueprintValidator(new MaterialCatalog(runtime.bot.registry)), { directory });
  const client = new OpenAICompatibleLLMClient({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey,
    model: config.llmModel, requestTimeoutMs: config.llmRequestTimeoutMs });
  const calls: Record<string, number> = {}, tools: Record<string, number> = {};
  let errors = 0, passed = false, finishedError: string | undefined, running: RunningAgentRuntime | undefined;
  const unsubscribe = subscribeTrace((event, raw) => {
    const e = raw as { phase?: string; tool?: string; error?: string; ok?: boolean };
    if (event === "llm.request") calls[e.phase ?? "unknown"] = (calls[e.phase ?? "unknown"] ?? 0) + 1;
    if (event === "tool.started") tools[e.tool!] = (tools[e.tool!] ?? 0) + 1;
    if (event === "tool.completed" && e.ok === false) errors++;
    if (event === "workflow.finished") finishedError = e.error;
  });
  const stop = new AbortController(), onStop = () => stop.abort("Live collection workflow stopped");
  process.on("SIGINT", onStop); process.on("SIGTERM", onStop);
  const request = async (prompt: string) => {
    finishedError = undefined;
    const began = performance.now();
    writeTrace("collect.workflow_request", { prompt });
    running!.agent.submitUserMessage("smoke", prompt);
    await until(() => (running!.agent.state() as { mode: string }).mode === "idle", 600_000, "Live collection workflow", stop.signal);
    await running!.waitForPhysicalIdle(10_000);
    assert.equal(finishedError, undefined, finishedError);
    writeTrace("collect.workflow_completed", { prompt, durationMs: Math.round(performance.now() - began), inventory: await inventory() });
  };
  try {
    running = await createAgentRuntime(runtime, { ...config, inspectorEnabled: false, landmarksFile: join(directory, "landmarks.json") }, undefined,
      { blueprintsDirectory: directory, llm: { async complete(input) {
        const response = await client.complete(input);
        // Test-only guard: a model must not construct outside the owned fixture.
        for (const call of response.message.toolCalls ?? []) if (call.name === "build") {
          const args = JSON.parse(call.arguments);
          assert.deepEqual(args.origin, { x: origin.x, y: origin.y, z: origin.z }, "Build outside owned test origin");
          const saved = await store.load(args.blueprintId); assert.ok(saved.ok);
          assert.equal(saved.value.blueprint.width, 5); assert.equal(saved.value.blueprint.depth, 5);
          assert.equal(saved.value.blueprint.layers.length, 4); assert.equal(saved.value.blueprint.dependencies.doors.length, 0);
        }
        return response;
      } } });
    running.chat.detach();
    const before = (await inventory()).oak_log ?? 0;
    await request((await readFile("tests/fixtures/prompts/collect-four-request.md", "utf8")).trim());
    assert.ok((await inventory()).oak_log! >= before + 4, "Independent inventory must confirm the first request");
    await request((await readFile("tests/fixtures/prompts/collect-build-request.md", "utf8")).trim()
      .replace("{{origin}}", `${origin.x}, ${origin.y}, ${origin.z}`));
    const id = running.agent.task.construction?.blueprint.blueprintId; assert.ok(id, "No accepted blueprint");
    const saved = await store.load(id); assert.ok(saved.ok);
    const bp = saved.value.blueprint;
    // Independent oracle reads every cell through the controller, not BuildProgress.
    await until(() => bp.layers.every((layer, y) => layer.every((row, z) => [...row].every((symbol, x) =>
      observer.blockAt(origin.offset(x, y, z))?.name === (symbol === "." ? "air" : bp.palette[symbol])))), 5000, "Controller blueprint verification");
    assert.ok(bp.layers[0]!.every(row => !row.includes(".")) && bp.layers[3]!.every(row => !row.includes(".")), "Solid floor and roof");
    for (let y = 1; y <= 2; y++) for (let z = 1; z <= 3; z++) for (let x = 1; x <= 3; x++) assert.equal(bp.layers[y]![z]![x], ".", "Interior must be empty");
    let entrance = false;
    for (let i = 1; i <= 3; i++) for (const [x, z] of [[i, 0], [i, 4], [0, i], [4, i]]) {
      if (bp.layers[1]![z!]![x!] === "." && bp.layers[2]![z!]![x!] === ".") entrance = true;
    }
    assert.ok(entrance, "Two vertically stacked air cells must form the entrance");
    assert.ok(running.agent.task.steps.length && running.agent.task.steps.every(s => s.status === "done"), "Coordinator must finish the checklist");
    passed = true;
    console.info("Live collection → craft → build workflow passed", { model: config.llmModel, calls, tools, errors });
  } finally {
    try {
      await cleanupSteps([
        { name: "stop live agent", run: () => running?.agent.shutdown() },
        { name: "physical settlement", run: () => running?.waitForPhysicalIdle(10_000) },
        { name: "test inventory", run: clearInventory },
        { name: "agent runtime", run: () => running?.shutdown("Collection workflow finished") },
      ], 15_000);
    } finally {
      writeTrace("collect.workflow_summary", { passed, model: config.llmModel, temperature: config.llmTemperature,
        reasoningEffort: config.llmReasoningEffort, durationMs: Math.round(performance.now() - started), calls, tools, errors });
      process.off("SIGINT", onStop); process.off("SIGTERM", onStop); unsubscribe();
    }
  }
}
