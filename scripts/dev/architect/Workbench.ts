import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ArchitectAgent } from "../../../src/agent/ArchitectAgent";
import { ArchitectTools, type ArchitectReport } from "../../../src/agent/ArchitectTools";
import { BlueprintStore, type StoredBlueprint } from "../../../src/building/BlueprintStore";
import { BlueprintValidator } from "../../../src/building/BlueprintValidator";
import { ARCHITECT_LIMITS } from "../../../src/building/BuildingConfig";
import { AgentInspector } from "../../../src/debug/AgentInspector";
import type { InspectorRound } from "../../../src/debug/InspectorTypes";
import { failure, type TaskResult } from "../../../src/execution/TaskResult";
import type { LLMClient, LLMRequestTrace } from "../../../src/llm/LLMClient";
import { PromptTemplate } from "../../../src/prompts/PromptTemplate";
import { subscribeTrace } from "../../../src/TraceLog";
import type { MaterialCatalog } from "../../../src/world/MaterialCatalog";

export const TrialInputSchema = z.object({
  request: z.string().trim().min(1).max(8000),
  instruction: z.string().trim().max(8000).default(""),
  constraints: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  observations: z.string().trim().max(8000).default(""),
  maxTokens: z.number().int().min(256).max(32768),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "max"]),
}).strict();
export type TrialInput = z.infer<typeof TrialInputSchema>;
export interface WorkbenchCall {
  key: string;
  trace: LLMRequestTrace;
  startedAt: string;
  finishedAt?: string;
  requestBody?: Record<string, unknown>;
  rawResponse?: unknown;
  round?: InspectorRound;
}
export interface TrialSummary {
  id: string;
  request: string;
  status: "running" | "stopping" | "accepted" | "failed" | "stopped";
  startedAt: string;
  finishedAt?: string;
  revision: number;
  calls: number;
  directory: string;
  artifactError?: string;
}
export interface Trial extends Omit<TrialSummary, "calls"> {
  input: TrialInput;
  settings: { model: string; temperature: number; maxCalls: number; minecraftVersion: string };
  prompts: { path: string; source: string }[];
  calls: WorkbenchCall[];
  result?: TaskResult<ArchitectReport>;
  blueprint?: StoredBlueprint;
}
export interface WorkbenchOptions {
  directory: string;
  promptsDirectory: string;
  catalog: MaterialCatalog;
  model: string;
  temperature: number;
  defaults: Pick<TrialInput, "maxTokens" | "reasoningEffort">;
  createClient: (inspector: AgentInspector) => LLMClient;
}

/** Dev-only harness: calls the production agent, never connects to Minecraft. */
export class ArchitectWorkbench {
  private sequence = 0;
  private readonly trials = new Map<string, { summary: TrialSummary; detail?: Trial }>();
  private active?: { trial: Trial; controller: AbortController; done: Promise<void> };
  private closed = false;
  constructor(private readonly options: WorkbenchOptions) {}

  state() {
    return { activeId: this.active?.trial.id ?? null, defaults: this.options.defaults,
      model: this.options.model, directory: resolve(this.options.directory),
      trials: [...this.trials.values()].map(({ summary }) => structuredClone(summary)).reverse() };
  }

  start(raw: unknown): TrialSummary {
    if (this.closed) throw new Error("Workbench is closing.");
    if (this.active) throw new Error("An Architect trial is already running. Stop it or wait for completion.");
    const input = TrialInputSchema.parse(raw);
    const id = `trial_${Date.now()}_${randomUUID()}`;
    const trial: Trial = { id, request: input.request, input, status: "running", startedAt: new Date().toISOString(),
      revision: 1, directory: resolve(this.options.directory, id), prompts: [], calls: [],
      settings: { model: this.options.model, temperature: this.options.temperature,
        maxCalls: ARCHITECT_LIMITS.maxCalls, minecraftVersion: this.options.catalog.minecraftVersion } };
    const controller = new AbortController();
    this.trials.set(id, { summary: summarize(trial), detail: trial });
    // Schedule only after reserving the active slot (including prompt loading and disk writes).
    const done = Promise.resolve().then(() => this.run(trial, ++this.sequence, controller.signal));
    this.active = { trial, controller, done };
    return summarize(trial);
  }

  async get(id: string): Promise<Trial | undefined> {
    const entry = this.trials.get(id);
    if (!entry) return undefined; // Never interpret an arbitrary path supplied by HTTP.
    return entry.detail ? structuredClone(entry.detail)
      : JSON.parse(await readFile(join(entry.summary.directory, "trial.json"), "utf8")) as Trial;
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.trial.status = "stopping";
    this.changed(active.trial);
    active.controller.abort("Workbench stop requested");
    await active.done; // Includes non-abortable publication and final trace persistence.
  }

  async close(): Promise<void> { this.closed = true; await this.stop(); }
  async waitForIdle(): Promise<void> { await this.active?.done; }

  private changed(trial: Trial): void {
    trial.revision++;
    this.trials.get(trial.id)!.summary = summarize(trial);
  }

  private async run(trial: Trial, generationId: number, signal: AbortSignal): Promise<void> {
    let unsubscribe = () => undefined as void;
    let writes = Promise.resolve();
    const archive = (event: string, data: unknown) => {
      const line = JSON.stringify({ timestamp: new Date().toISOString(), event, data }) + "\n";
      writes = writes.then(() => appendFile(join(trial.directory, "trace.jsonl"), line, "utf8"))
        .catch(error => { trial.artifactError = String(error); this.changed(trial); });
    };
    const inspector = new AgentInspector(100, trial.id);
    try {
      await mkdir(trial.directory, { recursive: true });
      signal.throwIfAborted();
      trial.prompts = await Promise.all(["architect.md", "context-summary.md"].map(async name => {
        const path = resolve(this.options.promptsDirectory, name);
        return { path, source: await readFile(path, "utf8") };
      }));
      // The source archived here is also the source rendered by this trial: no second file read.
      archive("trial.started", { input: trial.input, settings: trial.settings, prompts: trial.prompts });
      this.changed(trial);
      unsubscribe = subscribeTrace((event, data) => {
        if (!data || typeof data !== "object" || !("generationId" in data) || data.generationId !== generationId) return;
        if (!event.startsWith("llm.") && !event.startsWith("architect.") && event !== "inspector.round") return;
        archive(event, data);
        if (event === "llm.request" || event === "llm.raw_response" || event === "inspector.round") {
          const trace = data as LLMRequestTrace;
          const key = [trace.phase, trace.reflection, trace.round, trace.attempt].join(":");
          let call = trial.calls.find(row => row.key === key);
          if (!call) {
            call = { key, trace: { generationId, phase: trace.phase, reflection: trace.reflection,
              round: trace.round, attempt: trace.attempt, wakeType: trace.wakeType, permission: trace.permission },
              startedAt: new Date().toISOString() };
            trial.calls.push(call);
          }
          if (event === "llm.request" && "body" in data) call.requestBody = structuredClone(data.body as Record<string, unknown>);
          if (event === "llm.raw_response" && "raw" in data) call.rawResponse = structuredClone(data.raw);
          if (event === "inspector.round") {
            call.round = structuredClone(data as InspectorRound);
            call.finishedAt = new Date().toISOString();
          }
        }
        this.changed(trial);
      });
      const store = new BlueprintStore(new BlueprintValidator(this.options.catalog), { directory: join(trial.directory, "blueprints") });
      const agent = new ArchitectAgent({ llm: this.options.createClient(inspector), inspector,
        tools: new ArchitectTools(store),
        prompt: PromptTemplate.fromString(trial.prompts[0]!.path, trial.prompts[0]!.source),
        contextSummaryPrompt: PromptTemplate.fromString(trial.prompts[1]!.path, trial.prompts[1]!.source),
        maxTokens: trial.input.maxTokens, reasoningEffort: trial.input.reasoningEffort,
        temperature: this.options.temperature });
      trial.result = await agent.run({ userRequest: trial.input.request,
        instruction: trial.input.instruction || undefined,
        constraints: trial.input.constraints, observations: trial.input.observations || undefined }, { signal, generationId });
      if (trial.result.ok) {
        const loaded = await store.load(trial.result.value.blueprintId);
        if (loaded.ok) trial.blueprint = loaded.value;
        else trial.artifactError = loaded.error.message;
      }
    } catch (error: unknown) {
      trial.result = failure(signal.aborted ? "INTERRUPTED" : "INTERNAL_ERROR", String(error));
    } finally {
      inspector.finalizeOpenRounds(generationId, signal.aborted ? "aborted" : "error");
      unsubscribe();
      trial.status = trial.result?.ok ? "accepted" : signal.aborted ? "stopped" : "failed";
      trial.finishedAt = new Date().toISOString();
      this.changed(trial);
      archive("trial.finished", { result: trial.result, status: trial.status });
      await writes;
      try {
        await writeFile(join(trial.directory, "trial.json"), JSON.stringify(trial, null, 2), "utf8");
        this.trials.get(trial.id)!.detail = undefined; // Completed transcripts live on disk, not forever in RAM.
      } catch (error: unknown) { trial.artifactError = String(error); this.changed(trial); }
      this.active = undefined;
    }
  }
}

function summarize(trial: Trial): TrialSummary {
  const { id, request, status, startedAt, finishedAt, revision, directory, artifactError } = trial;
  return { id, request, status, startedAt, finishedAt, revision, directory, artifactError, calls: trial.calls.length };
}
