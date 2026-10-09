"use strict";
const $ = id => document.getElementById(id);
let state, latest, displayed, selectedId, selectedCall = 0, tab = "conversation", loading = 0, initialized = false;
const names = { running: "Running", stopping: "Stopping", accepted: "Blueprint accepted", failed: "Failed", stopped: "Stopped" };
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const pretty = value => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "(missing)";
const parsed = text => { try { return JSON.parse(text); } catch { return text; } };
function pre(value) { return el("pre", pretty(value)); }
function fold(title, value, open = false) { const d = el("details"); d.open = open; d.append(el("summary", title), pre(value)); return d; }
function toolArguments(title, args, open = false) {
  const value = parsed(args);
  if (typeof value?.drawing !== "string") return fold(title, value, open);
  const d = el("details"); d.open = open;
  d.append(el("summary", title), el("p", `${value.layer === undefined ? "drawing" : `Layer ${value.layer}`} · original text, unchanged`, "hint"), pre(value.drawing),
    fold("Exact JSON arguments", args));
  return d;
}
function toolFeedback(target, raw) {
  const result = typeof raw === "string" ? parsed(raw) : raw;
  const data = result?.ok ? result.value : result?.error?.facts;
  if (typeof data?.draft !== "string") { target.append(pre(result)); return; }
  const message = result.ok ? data.message : result.error?.message;
  if (message) target.append(el("p", message, result.ok ? "" : "notice"));
  if (data.annotatedDrawing) target.append(el("h3", "Rejected attempt · annotations"), pre(data.annotatedDrawing));
  target.append(el("h3", "Current draft · retained state"), pre(data.draft), fold("Exact JSON result", result));
}
function card(title, cls = "") { const c = el("article", undefined, `card ${cls}`); c.append(el("div", title, "tag")); return c; }
function showError(error) { $("error").textContent = String(error); $("error").hidden = false; }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || response.statusText); return value;
}
function duration(a, b) { return b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)} s` : "running"; }
function outcome(call) {
  const round = call.round, rawChoice = call.rawResponse?.choices?.[0];
  if (rawChoice?.finish_reason === "length" || round?.response?.finishReason === "length") return { text: "Output limit reached", failed: true };
  const failed = round?.toolExecutions?.find(tool => tool.ok === false);
  if (failed) return { text: parsed(failed.result)?.error?.facts?.reason || parsed(failed.result)?.error?.code || "Tool rejected", failed: true };
  if (round?.error || round?.validationError) return { text: round.error || round.validationError, failed: true };
  if (!round) return { text: "Generating", failed: false };
  return { text: round.outcome || round.status, failed: round.failed || ["error", "invalid_response", "tool_round_limit", "aborted"].includes(round.status) };
}
function toolNames(call) {
  const calls = call.round?.response?.toolCalls || call.rawResponse?.choices?.[0]?.message?.tool_calls || [];
  return calls.map(t => t.name || t.function?.name).filter(Boolean).join(", ") || "Model response";
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
  } catch (error) { showError(`Workbench connection: ${error.message}`); }
  finally { setTimeout(poll, 1200); }
}
function renderTrials() {
  $("trials").replaceChildren(...state.trials.map(trial => {
    const b = el("button", undefined, `trial ${trial.id === selectedId ? "selected" : ""} ${trial.status === "failed" ? "failed" : ""}`);
    b.append(el("strong", trial.request), el("small", `${names[trial.status]} · ${trial.calls} call(s) · ${duration(trial.startedAt, trial.finishedAt)}`));
    b.title = trial.id; b.onclick = () => selectTrial(trial.id).catch(showError); return b;
  }));
}
async function selectTrial(id) {
  selectedId = id; selectedCall = 0; displayed = latest = undefined;
  renderTrials(); $("detail").replaceChildren(el("p", "Loading…", "muted"));
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
    b.append(el("strong", `Call ${index + 1} · ${call.trace.phase === "architect" ? "Architect" : "Context summary"}`),
      el("small", toolNames(call)), el("small", `${duration(call.startedAt, call.finishedAt)} · ${result.text}`));
    b.onclick = () => { selectedCall = index; displayed = latest; renderCalls(); renderDetail(); };
    return b;
  }));
  if (!latest.calls.length) $("calls").append(el("p", latest.finishedAt ? "No LLM calls." : "Loading prompts…", "muted"));
}
function renderDetail() {
  if (!displayed) return;
  const trial = displayed, detail = $("detail"), call = trial.calls[selectedCall];
  detail.replaceChildren();
  $("trial-id").textContent = trial.id;
  $("title").textContent = trial.request;
  $("status").textContent = `${names[trial.status]} · ${trial.input.mode === "layers" ? "Layer by layer" : "Complete drawing"} · ${trial.calls.length} call(s) · ${duration(trial.startedAt, trial.finishedAt)} · ${trial.settings.model}`;
  $("refresh").hidden = displayed.revision === latest?.revision;
  if (trial.artifactError) detail.append(el("p", `Save error: ${trial.artifactError}`, "notice"));
  if (tab === "sources") return renderSources(detail, trial);
  if (tab === "blueprint") return renderBlueprints(detail, trial);
  if (tab === "raw") {
    const download = el("button", "Download full trial (.json)", "download");
    download.onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(trial, null, 2)], { type: "application/json" })); const link = el("a"); link.href = url; link.download = `${trial.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    detail.append(download);
    if (call) detail.append(fold("Exact request body sent to the LLM server", call.requestBody ?? call.round?.requestBody, true), fold("Raw response received (before parsing)", call.rawResponse ?? call.round?.rawResponse, true), fold("Inspector round record", call.round));
    else detail.append(pre(trial));
    return;
  }
  if (!call) {
    if (trial.result) detail.append(fold("Trial ended before the first LLM call", trial.result, true));
    else detail.append(el("p", "Waiting for the first call. Click ‘Refresh this detail’ when new data arrives.", "muted"));
    return;
  }
  renderConversation(detail, call);
  if (trial.result) detail.append(fold("Final delegation result", trial.result, !trial.result.ok));
}
function renderConversation(detail, call) {
  const body = call.requestBody || call.round?.requestBody || {}, round = call.round;
  const raw = call.rawResponse || round?.rawResponse, choice = raw?.choices?.[0], message = choice?.message;
  const metrics = el("div", undefined, "metrics");
  const usage = raw?.usage;
  for (const text of [`Max output ${body.max_tokens ?? "?"}`, `Effort ${body.reasoning_effort ?? "default"}`, duration(call.startedAt, call.finishedAt),
    `Finish: ${choice?.finish_reason ?? round?.response?.finishReason ?? "pending"}`, ...(usage ? [`Input ${usage.prompt_tokens ?? "?"} tokens`, `Output ${usage.completion_tokens ?? "?"} tokens`] : [])]) metrics.append(el("span", text));
  detail.append(metrics);
  const status = outcome(call);
  if (status.failed) detail.append(el("p", status.text, "notice"));
  const messages = body.messages || [];
  messages.forEach((msg, index) => {
    const c = card(`${index + 1} · ${msg.role}${msg.tool_call_id ? ` · ${msg.tool_call_id}` : ""}`);
    if (msg.role === "system" && typeof msg.content === "string") {
      c.append(el("p", "Rendered system prompt: all variables are already injected. The sections below are only a reading aid.", "hint"));
      const sections = msg.content.split(/(?=^#{1,3} )/m).filter(Boolean);
      for (const section of sections) c.append(fold(section.split("\n")[0].replace(/^#+\s*/, ""), section, true));
      c.append(fold("Exact system message, unsplit", msg.content));
    } else if (msg.role === "tool") toolFeedback(c, msg.content);
    else if (msg.content !== null && msg.content !== undefined) c.append(pre(typeof msg.content === "string" ? parsed(msg.content) : msg.content));
    for (const tool of msg.tool_calls || []) c.append(toolArguments(`Replayed call · ${tool.function?.name} · ${tool.id}`, tool.function?.arguments, true));
    detail.append(c);
  });
  const tools = card(`Tools supplied separately · ${(body.tools || []).length}`);
  tools.append(el("p", "These schemas are in the API request’s tools field, not in the messages.", "hint"));
  for (const tool of body.tools || []) { const fn = tool.function || tool; const d = el("details"); d.append(el("summary", fn.name), pre(fn.description), fold("Argument schema", fn.parameters)); tools.append(d); }
  detail.append(tools);
  const response = card("Response to this call", status.failed ? "bad" : "");
  if (!raw && !round?.response) response.append(el("p", "Generating. This client does not stream: the full response will appear when ready.", "muted"));
  const reasoning = round?.response?.reasoning ?? message?.reasoning ?? message?.reasoning_content;
  if (reasoning) response.append(fold("Reasoning returned by the local model", reasoning));
  const content = round?.response?.content ?? message?.content;
  response.append(el("h3", "Assistant content"), pre(content === null || content === undefined || content === "" ? "(no text)" : parsed(content)));
  const calls = round?.response?.toolCalls ?? message?.tool_calls ?? [];
  for (const tool of calls) {
    const name = tool.name || tool.function?.name, args = tool.arguments ?? tool.function?.arguments;
    response.append(toolArguments(`Tool call · ${name} · ${tool.id}`, args, true));
  }
  if (round?.validationError) response.append(el("p", round.validationError, "notice"));
  if (round?.error) response.append(el("p", round.error, "notice"));
  detail.append(response);
  for (const tool of round?.toolExecutions || []) {
    const c = card(`${tool.name} · ${tool.ok === true ? "success" : tool.ok === false ? "rejected / error" : "running"}`, tool.ok === false ? "bad" : "good");
    c.append(toolArguments("Submitted arguments", tool.arguments), el("h3", "Actual tool feedback"));
    toolFeedback(c, tool.result || "Pending"); detail.append(c);
  }
}
function renderSources(detail, trial) {
  detail.append(el("p", "Sources are frozen for this trial. Edit the files, then start a new trial. No server restart is needed.", "notice"));
  const input = card("Trial inputs & settings"); input.append(pre({ ...trial.input, ...trial.settings }), el("p", `Directory: ${trial.directory}`, "hint")); detail.append(input);
  for (const prompt of trial.prompts) { const c = card(prompt.path); c.append(pre(prompt.source)); detail.append(c); }
  detail.append(el("p", "context-summary.md is used only when context compaction is needed. Each call’s rendered system prompt is shown in Conversation.", "hint"));
}
function renderBlueprints(detail, trial) {
  detail.append(el("p", "Accepted means the format and materials are valid. It does not prove the house meets the request or can be built on a given site. No blocks are placed here.", "notice"));
  let count = 0;
  for (const call of trial.calls) {
    const tools = call.round?.response?.toolCalls ?? call.rawResponse?.choices?.[0]?.message?.tool_calls ?? [];
    for (const tool of tools) {
      const name = tool.name || tool.function?.name;
      if (["start_blueprint", "set_blueprint_layer", "finish_blueprint"].includes(name)) {
        count++;
        const feedback = call.round?.toolExecutions?.find(t => t.toolCallId === tool.id);
        const c = card(`${count} · ${name} · ${feedback?.ok === true ? "success" : feedback?.ok === false ? "rejected" : "not executed"}`, feedback?.ok === true ? "good" : "bad");
        c.append(toolArguments("Submitted arguments", tool.arguments ?? tool.function?.arguments, name === "set_blueprint_layer"));
        toolFeedback(c, feedback?.result || "No changes applied.");
        detail.append(c);
        continue;
      }
      if (name !== "submit_blueprint") continue;
      count++;
      const feedback = call.round?.toolExecutions?.find(t => t.toolCallId === tool.id);
      const c = card(`Submission ${count} · ${feedback?.ok === true ? "accepted" : feedback?.ok === false ? "rejected" : "not executed"}`, feedback?.ok === true ? "good" : "bad");
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
      if (textDrawing !== null) c.append(fold("Received drawing text", textDrawing, true));
      if (drawing && typeof drawing === "object") {
        c.append(el("h3", `${textDrawing !== null ? "Inferred dimensions" : drawing.name || "Legacy format"} · ${drawing.width ?? "?"} × ${drawing.depth ?? "?"} × ${drawing.layers?.length ?? "?"}`));
        c.append(el("p", "A = oak_planks · . = required air · bottom → top (Y), rows north → south (+Z), columns west → east (+X)", "hint"));
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
        if (drawing.dependencies) c.append(fold("Legacy format dependencies", drawing.dependencies));
        c.append(fold("Full arguments, without preview limits", args));
      } else c.append(el("p", "Arguments could not be parsed as JSON. Received text:", "notice"), pre(drawing));
      if (feedback?.result) c.append(fold("Validator result", parsed(feedback.result), true));
      detail.append(c);
    }
  }
  if (!count) detail.append(el("p", "No drawing tool calls yet. Check Conversation for format errors or output limits.", "muted"));
  if (trial.blueprint) detail.append(fold("Saved blueprint and calculated quantities", trial.blueprint));
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
