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
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campagne Minecraft</title><style>${css}</style></head><body>
<header><h1>Campagne Minecraft</h1><p id="campaign" class="muted"></p><p id="campaign-error" class="failed"></p>
<p><a href="events.jsonl">Événements de campagne</a> · <a href="campaign.json">Configuration</a></p></header>
<div id="overview" class="metrics"></div>
<section><h2>Essai</h2><select id="trial" aria-label="Choisir un essai"></select><p id="outcome" role="status"></p>
<div id="metrics" class="metrics"></div><p id="criterion"></p>
<details id="verification"><summary>Vérification finale indépendante</summary><pre id="verification-data"></pre></details>
<details><summary>Fichiers de cet essai (dont blueprints acceptés)</summary><p id="files"></p></details></section>
<section id="inspector" class="inspector" aria-label="Inspecteur des appels">
  <aside class="panel"><div class="panel-heading"><h2>Appels</h2><span id="activity-count" class="muted"></span></div>
    <div id="activity-list" class="activity-list" aria-label="Liste chronologique des appels"></div></aside>
  <section class="panel detail-panel"><div class="panel-heading"><h2 id="detail-title">Détail sélectionné</h2><p id="detail-meta" class="muted"></p></div>
    <div id="detail-tabs" class="tabs" role="tablist" aria-label="Contenu de l’appel"></div>
    <div id="detail" class="detail-content" role="tabpanel" tabindex="0"></div></section>
  <aside class="panel timeline-panel"><div class="panel-heading"><h2>Chronologie</h2><p class="muted">Temps depuis la prise en charge (secondes)</p></div>
    <div id="timeline" class="timeline" tabindex="0" aria-label="Durée des appels, défilement horizontal et vertical"></div>
    <p class="legend"><span class="llm-key">LLM</span><span class="tool-key">Tool</span><span class="failed">Erreur</span><span class="pending">Incomplet</span></p>
    <p class="timeline-note muted">Les délégations englobent leurs tools : leurs durées ne s’additionnent pas.</p></aside>
</section>
<section><h2>Appels par outil</h2><div class="table-scroll"><table><thead><tr><th>Outil</th><th>Appels</th><th>Échecs</th><th>Durée cumulée</th></tr></thead><tbody id="tools"></tbody></table></div></section>
<section><h2>Nombre d’appels par outil</h2><p class="muted">Essai sélectionné · chaque appel démarré compte une fois, y compris les délégations.</p>
<div id="histogram" class="histogram" aria-label="Histogramme du nombre d’appels par outil"></div>
<p id="histogram-legend" class="legend"><span class="tool-key">Autres appels</span><span class="failed">Échecs</span></p></section>
<script id="data" type="application/json">${payload}</script><script>${js}</script>
</body></html>`;
}
