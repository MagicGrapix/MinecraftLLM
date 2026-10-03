import { appendFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AgentConfig } from "../../src/agent/AgentConfig";
import { summarizeTrace } from "./Statistics";
import { renderReport, type ReportTrial } from "./Report";
import type { TraceEvent, TrialResult } from "./types";

export async function jsonFile(path: string, data: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2), "utf8");
  await rename(`${path}.tmp`, path);
}
export function recorder(path: string): (event: string, data: unknown) => void {
  return (event, data) => appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), event, data })}\n`, "utf8");
}

export async function createCampaign(directory: string, config: AgentConfig, settings: unknown): Promise<string> {
  await mkdir(directory, { recursive: true });
  const prompts = join(directory, "prompts");
  await cp(resolve(config.promptsDirectory), prompts, { recursive: true });
  await cp(resolve("skills"), join(directory, "skills"), { recursive: true });
  await cp(resolve("src"), join(directory, "source", "src"), { recursive: true });
  await cp(resolve("tests/e2e"), join(directory, "source", "tests", "e2e"), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "tsconfig.tests.json"]) {
    await cp(resolve(name), join(directory, "source", name));
  }
  let revision = "unavailable";
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    await writeFile(join(directory, "working-tree.patch"), execFileSync("git", ["diff", "HEAD"], { maxBuffer: 20 * 1024 * 1024 }));
  } catch { /* A source export can still run without Git. */ }
  const { llmApiKey: _secret, ...publicConfig } = config;
  await jsonFile(join(directory, "campaign.json"), { createdAt: new Date().toISOString(), revision, agent: publicConfig, settings });
  return prompts;
}

/** Includes untracked files; detects source/skill changes during a campaign. */
export async function sourceFingerprint(): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { hash.update(path); hash.update(await readFile(path)); }
    }
  }
  for (const directory of ["src", "skills", "tests/e2e"]) await walk(directory);
  return hash.digest("hex");
}

export async function finishTrial(campaignDirectory: string, trialDirectory: string, result: TrialResult): Promise<ReportTrial> {
  const events: TraceEvent[] = [];
  for (const filename of (await readdir(trialDirectory)).filter((name) => name.endsWith(".jsonl"))) {
    const content = await readFile(join(trialDirectory, filename), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as TraceEvent); }
      catch { events.push({ timestamp: new Date().toISOString(), event: "trace.incomplete_line", data: { filename } }); }
    }
  }
  const statistics = summarizeTrace(events);
  await jsonFile(join(trialDirectory, "result.json"), { ...result, statistics });
  const files = (await readdir(trialDirectory)).filter((name) => /\.(jsonl|json|log|md)$/.test(name)).sort();
  return { directory: relative(campaignDirectory, trialDirectory).replace(/\\/g, "/"), result, statistics, files };
}

export async function writeCampaignReport(directory: string, trials: readonly ReportTrial[], error?: string): Promise<void> {
  await jsonFile(join(directory, "results.json"), trials);
  await writeFile(join(directory, "report.html.tmp"), renderReport(directory, trials, error), "utf8");
  await rename(join(directory, "report.html.tmp"), join(directory, "report.html"));
}
