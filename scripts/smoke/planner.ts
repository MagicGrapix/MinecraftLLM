import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAgentConfig } from "../../src/agent/AgentConfig";
import { PlannerAgent } from "../../src/agent/PlannerAgent";
import { ToolCatalogBuilder, formatToolReference } from "../../src/agent/ToolCatalogBuilder";
import { createCapabilityRegistry } from "../../src/bootstrap/createCapabilities";
import { mcData } from "../../src/config";
import { AgentInspector } from "../../src/debug/AgentInspector";
import { ToolCallJournal } from "../../src/execution/ToolCallJournal";
import { getFullTraceFilePath, getLogFilePath } from "../../src/Logger";
import { OpenAICompatibleLLMClient } from "../../src/llm/OpenAICompatibleLLMClient";
import { loadWorkflowPrompts } from "../../src/prompts/WorkflowPrompts";
import { RecipeLibrary } from "../../src/recipes/RecipeLibrary";
import { RecipeTools } from "../../src/recipes/RecipeTools";
import type { ContainerSessionManager } from "../../src/runtime/ContainerSessionManager";
import { SESSION_ID } from "../../src/TraceLog";
import type { WorldQueries } from "../../src/world/WorldQueries";
import { MaterialCatalog } from "../../src/world/MaterialCatalog";
import { createLookupMaterialQuery } from "../../src/world/queries/LookupMaterial";
import { createDefaultWorldQueryRegistry } from "../../src/world/queries/defaultQueries";

/** Explicit LLM opt-in. Definitions only: no Minecraft connection or physical executor. */
async function main(): Promise<void> {
  const config = loadAgentConfig();
  const inspector = new AgentInspector(100);
  const prompts = await loadWorkflowPrompts(resolve(config.promptsDirectory));
  const library = await RecipeLibrary.load(resolve("recipes"), mcData);
  if (library.diagnostics().length) throw new Error(JSON.stringify(library.diagnostics()));
  const recipes = new RecipeTools(library);
  const journal = new ToolCallJournal(() => { throw new Error("Planner must never read physical inventory."); });
  // Catalogs register closures; no world or capability method is invoked by this smoke.
  const queries = createDefaultWorldQueryRegistry({} as WorldQueries, journal);
  queries.register(createLookupMaterialQuery(new MaterialCatalog(mcData)));
  const reference = new ToolCatalogBuilder(createCapabilityRegistry({} as ContainerSessionManager),
    queries, recipes.definitions).build();
  const agent = new PlannerAgent({
    llm: new OpenAICompatibleLLMClient({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey,
      model: config.llmModel, requestTimeoutMs: config.llmRequestTimeoutMs, maxRetries: 0, inspector }),
    recipes, journal, inspector, contextSummaryPrompt: prompts.contextSummary,
    temperature: config.llmTemperature, reasoningEffort: config.llmReasoningEffort,
    maxTokens: config.llmMaxTokens, maxRetries: config.responseMaxRetries,
  });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Planner smoke stopped."));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
  const directory = resolve("logs/planner");
  const file = resolve(directory, `planner_${SESSION_ID}.json`);
  let result: unknown;
  console.info("Planner-only smoke; mocked initial state, no Minecraft connection.", {
    model: config.llmModel, log: getLogFilePath(), trace: getFullTraceFilePath(), report: file,
  });
  try {
    const request = process.argv.slice(2).join(" ").trim() || (await readFile(resolve("tests/fixtures/prompts/planner-axe-shelter.md"), "utf8")).trim();
    result = await agent.run({
      conversation: [{ role: "user", content: request }], conversationSummary: "", objective: request,
      generationId: 1, reflection: 1, signal,
      render: (recent, summary) => ({ context: { objective: request, fixture: "axe-shelter", inventory: "empty" }, messages: [
        { role: "system", content: prompts.planner.render({
          task_context: "No plan yet.", task_summary_section: "",
          construction_context: "Supplied test blueprint (mock, not a saved building): oak_planks x66; open entrance, no door. Physical origin is not selected.",
          instruction: "Plan the player's objective from an empty inventory. Oak trees are available nearby. Use the supplied shelter bill; leave exact targets to the action agent.",
          world_context: "Bot position: (0, -60, 0)\nBot inventory: empty\nBot health: 20\nBot food: 20\nKnown places: none\nFixture observations, not a live world.",
          action_tools: formatToolReference(reference),
        }) },
        { role: "assistant", content: prompts.conversationSummary.render({ summary: summary || "empty. No earlier conversation has been compacted yet." }) },
        ...recent,
      ] }),
    });
    console.info("Planner report:", result);
    console.info("Review selected recipe snapshots, batches, stations and textual checks. Acceptance validates references and grammar, not semantic feasibility or execution. No live inventory was evaluated.");
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify({ result, rounds: inspector.listRounds().map(r => inspector.getRound(r.id)) }, null, 2), "utf8");
    console.info("Planner smoke report saved:", file);
  }
}

void main().catch(error => { console.error("Planner smoke failed:", error); process.exitCode = 1; });
