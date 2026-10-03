import { mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadAgentConfig } from "../../src/agent/AgentConfig";
import { loadWorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import { AgentProcess } from "./AgentProcess";
import { createCampaign, finishTrial, jsonFile, recorder, sourceFingerprint, writeCampaignReport } from "./Artifacts";
import { message } from "./async";
import { scenarioConfig } from "./config";
import { parseOptions, type CampaignOptions } from "./options";
import type { ReportTrial } from "./Report";
import { scenarios } from "./scenarios";
import { TestWorld } from "./TestWorld";
import { runTrial } from "./TrialRunner";
import type { Scenario, TrialResult } from "./types";

async function campaign(options: CampaignOptions, selected: readonly Scenario[], signal: AbortSignal): Promise<{ passed: boolean; fatal: boolean }> {
  const directory = resolve(scenarioConfig.outputDirectory, `campaign_${Date.now()}_${randomUUID().slice(0, 8)}`);
  const config = loadWorldBuilderConfig({ ...process.env,
    WORLD_CONTROLLER_USERNAME: scenarioConfig.controllerUsername,
    WORLD_AGENT_USERNAME: scenarioConfig.botUsername,
  });
  const fingerprint = await sourceFingerprint();
  const prompts = await createCampaign(directory, loadAgentConfig(), { ...options, world: config, sourceFingerprint: fingerprint, scenarios: selected.map(({ id, prompt, timeoutMs, initialInventory }) => ({ id, prompt, timeoutMs, initialInventory })) });
  const record = recorder(join(directory, "events.jsonl"));
  const world = new TestWorld(config, record);
  const results: ReportTrial[] = [];
  let bot: AgentProcess | null = null;
  let healthy = true;
  let campaignError: string | undefined;
  record("campaign.started", { scenarios: selected.map((s) => s.id) });
  console.info(`Campaign: ${directory}`);
  try {
    signal.throwIfAborted();
    await world.connect();
    let index = 0;
    for (const scenario of selected) {
      for (let repetition = 1; repetition <= options.repetitions; repetition++) {
        signal.throwIfAborted();
        if (await sourceFingerprint() !== fingerprint) throw new Error("Source or skills changed during the campaign. Start a new campaign to compare versions.");
        const trialDirectory = join(directory, `${String(++index).padStart(3, "0")}_${scenario.id}`);
        await mkdir(trialDirectory);
        const trace = recorder(join(trialDirectory, "events.jsonl"));
        const timeoutMs = options.timeoutMs ?? scenario.timeoutMs ?? scenarioConfig.timeoutMs;
        let result: TrialResult = { scenario: scenario.id, status: "error", timeoutMs, startedAt: new Date().toISOString(), durationMs: 0, goalReachedAtMs: null };
        const setupStarted = performance.now();
        console.info(`[${index}] ${scenario.id}, repeat ${repetition}/${options.repetitions}, limit ${timeoutMs / 1_000}s`);
        await jsonFile(join(trialDirectory, "scenario.json"), { id: scenario.id, prompt: scenario.prompt, timeoutMs, initialInventory: scenario.initialInventory });
        try {
          await world.prepareTerrain(scenario, signal);
          signal.throwIfAborted();
          bot = new AgentProcess(config, trialDirectory, prompts, trace);
          await bot.waitReady(scenarioConfig.startupTimeoutMs, signal);
          const initial = await world.preparePlayer(scenario, () => bot!.snapshot(), signal);
          const setupMs = performance.now() - setupStarted;
          result = await runTrial({
            scenario, agent: bot, initial, timeoutMs,
            acceptanceTimeoutMs: scenarioConfig.acceptanceTimeoutMs, pollMs: scenarioConfig.pollMs,
            sendChat: (text) => world.chat(text), record: trace, signal,
            inArena: (position) => { world.assertHealthy(); return world.inArena(position); },
          });
          result.setupMs = setupMs;
          if (result.status === "error") healthy = false;
          if (await sourceFingerprint() !== fingerprint) { result.status = "error"; result.error = "Source or skills changed during the trial."; healthy = false; }
        } catch (error) {
          result.status = "error";
          result.error = message(error);
          result.setupMs ??= performance.now() - setupStarted;
          healthy = false;
        } finally {
          if (bot) {
            try {
              // Chat is the same stop entry point as manual use. IPC then confirms settlement/exit.
              if (!bot.failure) await world.chat("stop").catch((error) => trace("stop.chat_error", { error: message(error) }));
              result.forcedShutdown = await bot.close(scenarioConfig.stopGraceMs);
              if (result.forcedShutdown && result.status !== "timeout") {
                result.status = "error"; result.error ??= "Physical shutdown required terminating the test process.";
              }
              await world.waitDisconnected();
            } catch (error) {
              result.status = "error"; result.error = `Cleanup could not be confirmed: ${message(error)}`; healthy = false;
            }
            bot = null;
          }
          trace("trial.saved", result);
          results.push(await finishTrial(directory, trialDirectory, result));
          await writeCampaignReport(directory, results);
          console.info(`  ${result.status}: ${(result.durationMs / 1_000).toFixed(2)}s — ${result.criterion?.actual ?? result.error ?? "No observation"}`);
        }
        if (!healthy || signal.aborted) { campaignError = result.error ?? "Campaign cancelled."; return { passed: false, fatal: true }; }
      }
    }
    // End with the empty baseline as well; archived observations retain the last experiment.
    await world.prepareTerrain({ ...selected[0]!, fixture: undefined, expectedBlocks: undefined }, signal);
    return { passed: results.every((trial) => trial.result.status === "passed"), fatal: false };
  } catch (error) {
    campaignError = message(error);
    record("campaign.error", { error: message(error) });
    console.error(message(error));
    return { passed: false, fatal: true };
  } finally {
    try { await world.close(); }
    catch (error) { campaignError = `Controller shutdown: ${message(error)}`; record("campaign.error", { error: campaignError }); throw error; }
    finally {
      record("campaign.finished", { error: campaignError ?? null, trials: results.length });
      await writeCampaignReport(directory, results, campaignError);
      console.info(`Report: ${join(directory, "report.html")}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.info("npm run test:scenarios -- [--list] [--scenario ID] [--timeout SECONDS] [--repeat N] [--campaigns N] [--interval SECONDS]\nServer must already be running. In its console: op test_controller. Ctrl+C stops the owned bots. Setup/reset modifies the configured arena.");
    return;
  }
  if (options.list) { for (const scenario of scenarios) console.info(`${scenario.id}: ${scenario.prompt}`); return; }
  const selected = scenarios.filter((s) => !options.scenario || s.id === options.scenario);
  if (!selected.length) throw new Error(`Unknown scenario: ${options.scenario}`);
  const root = resolve(scenarioConfig.outputDirectory);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, ".running.lock");
  // Exclusive create; never unlink a lock belonging to another runner.
  const lock = await open(lockPath, "wx").catch(() => { throw new Error(`A campaign lock exists at ${lockPath}. If a previous runner crashed, confirm it is gone before removing that file.`); });
  const abort = new AbortController();
  const stop = () => { if (!abort.signal.aborted) { console.info("Stopping campaign..."); abort.abort("Campaign cancelled."); } };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    for (let iteration = 0; iteration < options.campaigns; iteration++) {
      const outcome = await campaign(options, selected, abort.signal);
      if (!outcome.passed) process.exitCode = 1;
      if (abort.signal.aborted || outcome.fatal) break;
      if (iteration + 1 < options.campaigns) await delay(options.intervalMs, undefined, { signal: abort.signal });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lock.close();
    await unlink(lockPath);
  }
}

void main().catch((error) => { console.error(message(error)); process.exitCode = 1; });
