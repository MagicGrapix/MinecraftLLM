import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Statistics } from "./Statistics";
import type { TrialResult } from "./types";

export interface ReportTrial { directory: string; result: TrialResult; statistics: Statistics; files?: string[] }

/** Embed the UI and recorded data so the report remains usable after the campaign exits. */
export function renderReport(campaignId: string, trials: readonly ReportTrial[], error?: string): string {
  const payload = JSON.stringify({ campaignId, trials, error }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const css = readFileSync(join(__dirname, "report", "report.css"), "utf8");
  const js = readFileSync(join(__dirname, "report", "report.js"), "utf8");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minecraft Campaign</title><style>${css}</style></head><body>
<header><h1>Minecraft Campaign</h1><p id="campaign" class="muted"></p><p id="campaign-error" class="failed"></p>
<p><a href="events.jsonl">Campaign events</a> · <a href="campaign.json">Configuration</a></p></header>
<div id="overview" class="metrics"></div>
<section><h2>Trial</h2><select id="trial" aria-label="Choose a trial"></select><p id="outcome" role="status"></p>
<div id="metrics" class="metrics"></div><p id="criterion"></p>
<details id="verification"><summary>Independent final verification</summary><pre id="verification-data"></pre></details>
<details><summary>Trial files (including accepted blueprints)</summary><p id="files"></p></details></section>
<section id="inspector" class="inspector" aria-label="Call inspector">
  <aside class="panel"><div class="panel-heading"><h2>Calls</h2><span id="activity-count" class="muted"></span></div>
    <div id="activity-list" class="activity-list" aria-label="Calls in chronological order"></div></aside>
  <section class="panel detail-panel"><div class="panel-heading"><h2 id="detail-title">Selected detail</h2><p id="detail-meta" class="muted"></p></div>
    <div id="detail-tabs" class="tabs" role="tablist" aria-label="Call content"></div>
    <div id="detail" class="detail-content" role="tabpanel" tabindex="0"></div></section>
  <aside class="panel timeline-panel"><div class="panel-heading"><h2>Timeline</h2><p class="muted">Time since request acceptance (seconds)</p></div>
    <div id="timeline" class="timeline" tabindex="0" aria-label="Call durations, scroll horizontally and vertically"></div>
    <p class="legend"><span class="llm-key">LLM</span><span class="tool-key">Tool</span><span class="failed">Failed</span><span class="pending">Incomplete</span></p>
    <p class="timeline-note muted">Delegations include their tools: nested durations must not be added together.</p></aside>
</section>
<section><h2>Calls by tool</h2><div class="table-scroll"><table><thead><tr><th>Tool</th><th>Calls</th><th>Failures</th><th>Total duration</th></tr></thead><tbody id="tools"></tbody></table></div></section>
<section><h2>Call count by tool</h2><p class="muted">Selected trial · each started call counts once, including delegations.</p>
<div id="histogram" class="histogram" aria-label="Tool call count chart"></div>
<p id="histogram-legend" class="legend"><span class="tool-key">Other calls</span><span class="failed">Failures</span></p></section>
<script id="data" type="application/json">${payload}</script><script>${js}</script>
</body></html>`;
}
