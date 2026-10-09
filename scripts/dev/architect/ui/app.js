"use strict";
const $ = id => document.getElementById(id);
let state, latest, displayed, selectedId, selectedCall = 0, tab = "conversation", loading = 0, initialized = false;
const names = { running: "En cours", stopping: "Arrêt en cours", accepted: "Blueprint accepté", failed: "Échec", stopped: "Arrêté" };
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const pretty = value => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "(absent)";
const parsed = text => { try { return JSON.parse(text); } catch { return text; } };
function pre(value) { return el("pre", pretty(value)); }
function fold(title, value, open = false) { const d = el("details"); d.open = open; d.append(el("summary", title), pre(value)); return d; }
function toolArguments(title, args, open = false) {
  const value = parsed(args);
  if (typeof value?.drawing !== "string") return fold(title, value, open);
  const d = el("details"); d.open = open;
  d.append(el("summary", title), el("p", `${value.layer === undefined ? "drawing" : `Layer ${value.layer}`} · texte reçu, sans transformation`, "hint"), pre(value.drawing),
    fold("Arguments JSON exacts", args));
  return d;
}
function toolFeedback(target, raw) {
  const result = typeof raw === "string" ? parsed(raw) : raw;
  const data = result?.ok ? result.value : result?.error?.facts;
  if (typeof data?.draft !== "string") { target.append(pre(result)); return; }
  const message = result.ok ? data.message : result.error?.message;
  if (message) target.append(el("p", message, result.ok ? "" : "notice"));
  if (data.annotatedDrawing) target.append(el("h3", "Tentative rejetée · annotations"), pre(data.annotatedDrawing));
  target.append(el("h3", "Brouillon courant · état conservé"), pre(data.draft), fold("Résultat JSON exact", result));
}
function card(title, cls = "") { const c = el("article", undefined, `card ${cls}`); c.append(el("div", title, "tag")); return c; }
function showError(error) { $("error").textContent = String(error); $("error").hidden = false; }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || response.statusText); return value;
}
function duration(a, b) { return b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)} s` : "en cours"; }
function outcome(call) {
  const round = call.round, rawChoice = call.rawResponse?.choices?.[0];
  if (rawChoice?.finish_reason === "length" || round?.response?.finishReason === "length") return { text: "Limite de sortie atteinte", failed: true };
  const failed = round?.toolExecutions?.find(tool => tool.ok === false);
  if (failed) return { text: parsed(failed.result)?.error?.facts?.reason || parsed(failed.result)?.error?.code || "Outil refusé", failed: true };
  if (round?.error || round?.validationError) return { text: round.error || round.validationError, failed: true };
  if (!round) return { text: "Génération en cours", failed: false };
  return { text: round.outcome || round.status, failed: round.failed || ["error", "invalid_response", "tool_round_limit", "aborted"].includes(round.status) };
}
function toolNames(call) {
  const calls = call.round?.response?.toolCalls || call.rawResponse?.choices?.[0]?.message?.tool_calls || [];
  return calls.map(t => t.name || t.function?.name).filter(Boolean).join(", ") || "Réponse du modèle";
}
async function poll() {
  try {
    const next = await api("/api/state");
    if (!initialized) {
      $("tokens").value = next.defaults.maxTokens; $("reasoning").value = next.defaults.reasoningEffort;
      initialized = true;
    }
    const changed = JSON.stringify(state?.trials) !== JSON.stringify(next.trials);
    state = next;
    $("model").textContent = state.model;
    $("start").disabled = !!state.activeId; $("stop").disabled = !state.activeId;
    $("count").textContent = state.trials.length;
    if (changed) renderTrials();
    const summary = state.trials.find(t => t.id === selectedId);
    if (summary && summary.revision !== latest?.revision) await fetchSelected(false);
    if (!selectedId && state.trials.length) await selectTrial(state.trials[0].id);
  } catch (error) { showError(`Connexion à l’atelier : ${error.message}`); }
  finally { setTimeout(poll, 1200); }
}
function renderTrials() {
  $("trials").replaceChildren(...state.trials.map(trial => {
    const b = el("button", undefined, `trial ${trial.id === selectedId ? "selected" : ""} ${trial.status === "failed" ? "failed" : ""}`);
    b.append(el("strong", trial.request), el("small", `${names[trial.status]} · ${trial.calls} appel(s) · ${duration(trial.startedAt, trial.finishedAt)}`));
    b.title = trial.id; b.onclick = () => selectTrial(trial.id).catch(showError); return b;
  }));
}
async function selectTrial(id) {
  selectedId = id; selectedCall = 0; displayed = latest = undefined;
  renderTrials(); $("detail").replaceChildren(el("p", "Chargement…", "muted"));
  await fetchSelected(true);
}
async function fetchSelected(force) {
  const id = selectedId, version = ++loading;
  const trial = await api(`/api/trials/${id}`);
  if (id !== selectedId || version !== loading) return;
  latest = trial; renderCalls();
  // Never replace text being read during background polling.
  if (force || !displayed) { displayed = latest; renderDetail(); }
  $("refresh").hidden = displayed.revision === latest.revision;
}
function renderCalls() {
  $("calls").replaceChildren(...latest.calls.map((call, index) => {
    const result = outcome(call);
    const b = el("button", undefined, `call ${index === selectedCall ? "selected" : ""} ${result.failed ? "failed" : ""}`);
    b.append(el("strong", `Appel ${index + 1} · ${call.trace.phase === "architect" ? "Architect" : "Résumé du contexte"}`),
      el("small", toolNames(call)), el("small", `${duration(call.startedAt, call.finishedAt)} · ${result.text}`));
    b.onclick = () => { selectedCall = index; displayed = latest; renderCalls(); renderDetail(); };
    return b;
  }));
  if (!latest.calls.length) $("calls").append(el("p", latest.finishedAt ? "Aucun appel LLM." : "Chargement des prompts…", "muted"));
}
function renderDetail() {
  if (!displayed) return;
  const trial = displayed, detail = $("detail"), call = trial.calls[selectedCall];
  detail.replaceChildren();
  $("trial-id").textContent = trial.id;
  $("title").textContent = trial.request;
  $("status").textContent = `${names[trial.status]} · ${trial.input.mode === "layers" ? "Couche par couche" : "Dessin complet"} · ${trial.calls.length} appel(s) · ${duration(trial.startedAt, trial.finishedAt)} · ${trial.settings.model}`;
  $("refresh").hidden = displayed.revision === latest?.revision;
  if (trial.artifactError) detail.append(el("p", `Erreur de sauvegarde : ${trial.artifactError}`, "notice"));
  if (tab === "sources") return renderSources(detail, trial);
  if (tab === "blueprint") return renderBlueprints(detail, trial);
  if (tab === "raw") {
    const download = el("button", "Télécharger l’essai complet (.json)", "download");
    download.onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(trial, null, 2)], { type: "application/json" })); const link = el("a"); link.href = url; link.download = `${trial.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    detail.append(download);
    if (call) detail.append(fold("Corps exact envoyé au serveur LLM", call.requestBody ?? call.round?.requestBody, true), fold("Réponse brute reçue (avant parsing)", call.rawResponse ?? call.round?.rawResponse, true), fold("Round enregistré par l’inspecteur", call.round));
    else detail.append(pre(trial));
    return;
  }
  if (!call) {
    if (trial.result) detail.append(fold("Essai terminé avant le premier appel LLM", trial.result, true));
    else detail.append(el("p", "En attente du premier appel. Clique sur « Actualiser ce détail » quand les données arrivent.", "muted"));
    return;
  }
  renderConversation(detail, call);
  if (trial.result) detail.append(fold("Résultat final de la délégation", trial.result, !trial.result.ok));
}
function renderConversation(detail, call) {
  const body = call.requestBody || call.round?.requestBody || {}, round = call.round;
  const raw = call.rawResponse || round?.rawResponse, choice = raw?.choices?.[0], message = choice?.message;
  const metrics = el("div", undefined, "metrics");
  const usage = raw?.usage;
  for (const text of [`Sortie max. ${body.max_tokens ?? "?"}`, `Effort ${body.reasoning_effort ?? "défaut"}`, duration(call.startedAt, call.finishedAt),
    `Fin : ${choice?.finish_reason ?? round?.response?.finishReason ?? "en attente"}`, ...(usage ? [`Entrée ${usage.prompt_tokens ?? "?"} tokens`, `Sortie ${usage.completion_tokens ?? "?"} tokens`] : [])]) metrics.append(el("span", text));
  detail.append(metrics);
  const status = outcome(call);
  if (status.failed) detail.append(el("p", status.text, "notice"));
  const messages = body.messages || [];
  messages.forEach((msg, index) => {
    const c = card(`${index + 1} · ${msg.role}${msg.tool_call_id ? ` · ${msg.tool_call_id}` : ""}`);
    if (msg.role === "system" && typeof msg.content === "string") {
      c.append(el("p", "Prompt système rendu : toutes les variables sont déjà injectées. Les sections ci-dessous sont uniquement une aide de lecture.", "hint"));
      const sections = msg.content.split(/(?=^#{1,3} )/m).filter(Boolean);
      for (const section of sections) c.append(fold(section.split("\n")[0].replace(/^#+\s*/, ""), section, true));
      c.append(fold("Message système exact, sans découpage", msg.content));
    } else if (msg.role === "tool") toolFeedback(c, msg.content);
    else if (msg.content !== null && msg.content !== undefined) c.append(pre(typeof msg.content === "string" ? parsed(msg.content) : msg.content));
    for (const tool of msg.tool_calls || []) c.append(toolArguments(`Appel rejoué · ${tool.function?.name} · ${tool.id}`, tool.function?.arguments, true));
    detail.append(c);
  });
  const tools = card(`Outils fournis séparément · ${(body.tools || []).length}`);
  tools.append(el("p", "Ces schémas sont dans le champ tools de la requête API, pas dans les messages.", "hint"));
  for (const tool of body.tools || []) { const fn = tool.function || tool; const d = el("details"); d.append(el("summary", fn.name), pre(fn.description), fold("Schéma des arguments", fn.parameters)); tools.append(d); }
  detail.append(tools);
  const response = card("Réponse de cet appel", status.failed ? "bad" : "");
  if (!raw && !round?.response) response.append(el("p", "Génération en cours. Le client n’utilise pas le streaming : la réponse arrivera entière.", "muted"));
  const reasoning = round?.response?.reasoning ?? message?.reasoning ?? message?.reasoning_content;
  if (reasoning) response.append(fold("Réflexion renvoyée par le modèle local", reasoning));
  const content = round?.response?.content ?? message?.content;
  response.append(el("h3", "Contenu assistant"), pre(content === null || content === undefined || content === "" ? "(aucun texte)" : parsed(content)));
  const calls = round?.response?.toolCalls ?? message?.tool_calls ?? [];
  for (const tool of calls) {
    const name = tool.name || tool.function?.name, args = tool.arguments ?? tool.function?.arguments;
    response.append(toolArguments(`Tool call · ${name} · ${tool.id}`, args, true));
  }
  if (round?.validationError) response.append(el("p", round.validationError, "notice"));
  if (round?.error) response.append(el("p", round.error, "notice"));
  detail.append(response);
  for (const tool of round?.toolExecutions || []) {
    const c = card(`${tool.name} · ${tool.ok === true ? "succès" : tool.ok === false ? "refus / erreur" : "en cours"}`, tool.ok === false ? "bad" : "good");
    c.append(toolArguments("Arguments soumis", tool.arguments), el("h3", "Feedback réel de l’outil"));
    toolFeedback(c, tool.result || "En attente"); detail.append(c);
  }
}
function renderSources(detail, trial) {
  detail.append(el("p", "Les sources sont figées pour cet essai. Modifie les fichiers dans ton éditeur, puis lance un nouvel essai : le serveur n’a pas besoin d’être redémarré.", "notice"));
  const input = card("Entrées & réglages de cet essai"); input.append(pre({ ...trial.input, ...trial.settings }), el("p", `Dossier : ${trial.directory}`, "hint")); detail.append(input);
  for (const prompt of trial.prompts) { const c = card(prompt.path); c.append(pre(prompt.source)); detail.append(c); }
  detail.append(el("p", "context-summary.md n’est appelé que si la compression de contexte devient nécessaire. Le système rendu de chaque appel est visible dans Conversation.", "hint"));
}
function renderBlueprints(detail, trial) {
  detail.append(el("p", "Accepté = format et matériaux validés. Cela ne prouve ni que la maison répond à la demande, ni qu’elle est constructible sur un terrain donné. Aucun bloc n’est posé ici.", "notice"));
  let count = 0;
  for (const call of trial.calls) {
    const tools = call.round?.response?.toolCalls ?? call.rawResponse?.choices?.[0]?.message?.tool_calls ?? [];
    for (const tool of tools) {
      const name = tool.name || tool.function?.name;
      if (["start_blueprint", "set_blueprint_layer", "finish_blueprint"].includes(name)) {
        count++;
        const feedback = call.round?.toolExecutions?.find(t => t.toolCallId === tool.id);
        const c = card(`${count} · ${name} · ${feedback?.ok === true ? "succès" : feedback?.ok === false ? "refus" : "non exécuté"}`, feedback?.ok === true ? "good" : "bad");
        c.append(toolArguments("Arguments soumis", tool.arguments ?? tool.function?.arguments, name === "set_blueprint_layer"));
        toolFeedback(c, feedback?.result || "Aucun changement appliqué.");
        detail.append(c);
        continue;
      }
      if (name !== "submit_blueprint") continue;
      count++;
      const feedback = call.round?.toolExecutions?.find(t => t.toolCallId === tool.id);
      const c = card(`Soumission ${count} · ${feedback?.ok === true ? "acceptée" : feedback?.ok === false ? "refusée" : "non exécutée"}`, feedback?.ok === true ? "good" : "bad");
      const args = parsed(tool.arguments ?? tool.function?.arguments);
      const textDrawing = typeof args?.drawing === "string" ? args.drawing : null;
      // Preview only. The server validator alone decides acceptance; retain exact text below.
      const groups = [];
      if (textDrawing !== null) {
        let rows = [];
        for (const line of textDrawing.replace(/\r\n?/g, "\n").split("\n")) {
          if (/^[ \t]*$/.test(line)) { if (rows.length) { groups.push(rows); rows = []; } }
          else rows.push(line);
        }
        if (rows.length) groups.push(rows);
      }
      const drawing = textDrawing !== null
        ? { width: groups[0]?.[0]?.length, depth: groups[0]?.length, layers: groups, palette: { A: "oak_planks" } } : args;
      if (textDrawing !== null) c.append(fold("Dessin texte reçu", textDrawing, true));
      if (drawing && typeof drawing === "object") {
        c.append(el("h3", `${textDrawing !== null ? "Dimensions déduites" : drawing.name || "Ancien format"} · ${drawing.width ?? "?"} × ${drawing.depth ?? "?"} × ${drawing.layers?.length ?? "?"}`));
        c.append(el("p", "A = oak_planks · . = air requis · bas → haut (Y), lignes nord → sud (+Z), colonnes ouest → est (+X)", "hint"));
        if (textDrawing === null) c.append(pre(drawing.palette));
        const layers = el("div", undefined, "layers");
        if (Array.isArray(drawing.layers)) drawing.layers.slice(0, 16).forEach((layer, y) => {
          const box = el("div", undefined, "layer"); box.append(el("strong", `Y = ${y}`));
          if (Array.isArray(layer)) layer.slice(0, 32).forEach((row, z) => {
            if (typeof row !== "string") { box.append(pre(row)); return; }
            const r = el("div", undefined, "row");
            [...row.slice(0, 64)].forEach((symbol, x) => {
              const cell = el("span", symbol, `cell ${symbol === "." ? "air" : symbol === "_" ? "ignore" : ""}`);
              cell.title = `x=${x}, y=${y}, z=${z} · ${drawing.palette?.[symbol] || symbol}`; r.append(cell);
            }); box.append(r);
          }); else box.append(pre(layer));
          layers.append(box);
        });
        c.append(layers);
        if (drawing.dependencies) c.append(fold("Dépendances de l’ancien format", drawing.dependencies));
        c.append(fold("Arguments complets, sans limite d’aperçu", args));
      } else c.append(el("p", "Arguments non parsables en JSON. Texte reçu :", "notice"), pre(drawing));
      if (feedback?.result) c.append(fold("Résultat du validateur", parsed(feedback.result), true));
      detail.append(c);
    }
  }
  if (!count) detail.append(el("p", "Aucun outil de dessin reçu pour l’instant. Consulte Conversation pour les erreurs de format ou limites de sortie.", "muted"));
  if (trial.blueprint) detail.append(fold("Blueprint sauvegardé et quantités calculées", trial.blueprint));
}
$("form").onsubmit = async event => {
  event.preventDefault(); $("error").hidden = true; $("start").disabled = true;
  try {
    const trial = await api("/api/trials", { mode: $("mode").value, request: $("request").value, instruction: $("instruction").value,
      constraints: $("constraints").value.split("\n").map(s => s.trim()).filter(Boolean), observations: $("observations").value,
      maxTokens: Number($("tokens").value), reasoningEffort: $("reasoning").value });
    state = await api("/api/state"); await selectTrial(trial.id);
  } catch (error) { showError(error.message); $("start").disabled = !!state?.activeId; }
};
$("stop").onclick = async () => { $("stop").disabled = true; try { await api("/api/stop", {}); } catch (error) { showError(error.message); } };
$("refresh").onclick = () => { displayed = latest; renderDetail(); };
document.querySelectorAll("[data-tab]").forEach(button => { button.onclick = () => {
  tab = button.dataset.tab; document.querySelectorAll("[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b === button)));
  displayed = latest; renderDetail();
}; });
void poll();
