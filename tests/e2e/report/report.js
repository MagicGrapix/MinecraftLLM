/* Runs only in the exported report. All recorded text is rendered with textContent. */
const data = JSON.parse(document.getElementById('data').textContent);
const el = id => document.getElementById(id);
const seconds = ms => (ms / 1000).toFixed(2) + ' s';
const statuses = { completed: 'Terminé', failed: 'Erreur', incomplete: 'Incomplet' };
const agents = { actioner: 'Actionneur', coordinator: 'Coordinateur', planner: 'Planner' };
let activities = [], selected = -1, pane = 'prompt', listButtons = [], timelineRows = [];

function node(tag, text, parent, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  if (parent) parent.append(n);
  return n;
}
function metric(parent, label, value) {
  const box = node('div', undefined, parent, 'metric');
  node('strong', value, box); node('span', label, box);
}
function parsed(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function pretty(value) {
  const decoded = parsed(value);
  return typeof decoded === 'string' ? decoded : JSON.stringify(decoded, null, 2) ?? '—';
}
function block(parent, heading, value) {
  const box = node('section', undefined, parent, 'message');
  node('h3', heading, box); node('pre', pretty(value), box);
  return box;
}
function responseMessage(activity) { return activity.details?.response?.choices?.[0]?.message; }
function toolCalls(message) { return message?.tool_calls ?? message?.toolCalls ?? []; }
function callName(call) { return call.function?.name ?? call.name ?? 'tool'; }
function callArguments(call) { return call.function?.arguments ?? call.arguments ?? {}; }
function calls(parent, message) {
  for (const call of toolCalls(message)) block(parent, 'Appel proposé · ' + callName(call), callArguments(call));
}
function messages(parent, values) {
  for (const [index, message] of values.entries()) {
    const box = node('section', undefined, parent, 'message');
    node('h3', message.role + ' · message ' + (index + 1), box);
    if (message.content !== null && message.content !== undefined && message.content !== '') node('pre', pretty(message.content), box);
    calls(box, message);
    if (message.tool_call_id ?? message.toolCallId) node('small', 'Résultat de ' + (message.tool_call_id ?? message.toolCallId), box, 'muted');
  }
}
function title(a) {
  return a.kind === 'llm' ? (agents[a.agent] ?? a.agent) + ' · LLM ' + a.llmNumber : a.label;
}
function preview(a) {
  const d = a.details ?? {};
  if (d.error) return d.error.message ?? pretty(d.error);
  if (a.kind === 'llm') {
    const message = responseMessage(a);
    return toolCalls(message).map(callName).join(', ') || message?.content || d.model || 'Appel en cours';
  }
  const result = parsed(d.result);
  return result?.error?.message ?? pretty(d.context?.arguments ?? d.arguments ?? '');
}

function selectActivity(index) {
  selected = index;
  listButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  timelineRows.forEach((row, i) => row.classList.toggle('selected', i === index));
  renderDetail();
}
function renderDetail() {
  const a = activities[selected], detail = el('detail'), tabs = el('detail-tabs');
  detail.replaceChildren(); tabs.replaceChildren(); detail.scrollTop = 0;
  if (!a) {
    el('detail-title').textContent = 'Détail sélectionné'; el('detail-meta').textContent = '';
    node('p', 'Aucun appel enregistré pour cet essai.', detail, 'empty'); return;
  }
  const d = a.details ?? {}, request = d.request;
  el('detail-title').textContent = title(a);
  el('detail-meta').textContent = [statuses[a.status], 'Début ' + seconds(a.startMs), a.durationMs === null ? 'Durée inconnue' : 'Durée ' + seconds(a.durationMs), d.model].filter(Boolean).join(' · ');
  const panes = a.kind === 'llm' ? [['prompt', 'Prompt'], ['response', 'Réponse'], ['raw', 'Données brutes']] : [['result', 'Résultat'], ['arguments', 'Arguments'], ['raw', 'Données brutes']];
  if (!panes.some(([id]) => id === pane)) pane = panes[0][0];
  for (const [id, label] of panes) {
    const button = node('button', label, tabs);
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(pane === id));
    button.id = 'tab-' + id; button.setAttribute('aria-controls', 'detail');
    button.onclick = () => { pane = id; renderDetail(); };
  }
  detail.setAttribute('aria-labelledby', 'tab-' + pane);
  if (d.error) node('pre', d.error.message ?? pretty(d.error), detail, 'error failed');
  if (pane === 'raw') { node('pre', pretty(a.details), detail); return; }
  if (pane === 'arguments') { block(detail, 'Arguments envoyés', d.context?.arguments ?? d.arguments ?? {}); return; }
  if (pane === 'result') {
    block(detail, 'Résultat retourné', d.result ?? 'Résultat indisponible : appel incomplet.');
    if (d.before || d.after) block(detail, 'Inventaire observé avant / après', { before: d.before, after: d.after });
    return;
  }
  if (pane === 'prompt') {
    if (!request?.messages) {
      node('p', 'La requête n’est pas conservée dans cet ancien rapport. Régénérer le rapport depuis les traces pour lire le prompt exact.', detail, 'empty'); return;
    }
    node('p', [request.model, request.max_tokens !== undefined ? 'Sortie max : ' + request.max_tokens + ' tokens' : '', request.temperature !== undefined ? 'Température : ' + request.temperature : ''].filter(Boolean).join(' · '), detail, 'muted');
    messages(detail, request.messages);
    if (request.tools?.length) {
      const fold = node('details', undefined, detail);
      node('summary', 'Tools transmis à cet appel (' + request.tools.length + ')', fold);
      for (const tool of request.tools) {
        const definition = tool.function ?? tool;
        block(fold, definition.name, { description: definition.description, parameters: definition.parameters });
      }
    }
    return;
  }
  const message = responseMessage(a);
  if (!message) { node('p', 'Aucune réponse LLM enregistrée.', detail, 'empty'); return; }
  const usage = d.response.usage;
  node('p', ['Fin : ' + d.response.choices[0].finish_reason, usage ? 'Tokens entrée / sortie : ' + usage.prompt_tokens + ' / ' + usage.completion_tokens : ''].filter(Boolean).join(' · '), detail, 'muted');
  if (message.content) block(detail, 'Réponse de l’assistant', message.content);
  calls(detail, message);
  if (!message.content && !toolCalls(message).length) node('p', 'Réponse sans texte ni appel de tool.', detail, 'empty');
  const reasoning = message.reasoning ?? message.reasoning_content;
  if (reasoning) { const fold = node('details', undefined, detail); node('summary', 'Analyse du modèle (trace)', fold); node('pre', reasoning, fold); }
}

function renderActivities(trial) {
  let llmNumber = 0;
  activities = [...trial.statistics.activities].sort((a, b) => a.startMs - b.startMs).map(a => ({ ...a, llmNumber: a.kind === 'llm' ? ++llmNumber : null }));
  const list = el('activity-list'), timeline = el('timeline');
  list.replaceChildren(); timeline.replaceChildren(); listButtons = []; timelineRows = [];
  el('activity-count').textContent = activities.length + ' événements';
  const duration = Math.max(1, trial.result.durationMs, ...activities.map(a => a.startMs + (a.durationMs ?? 0)));
  const axis = node('div', undefined, timeline, 'timeline-axis'); node('span', 'Appel', axis, 'timeline-label');
  const ticks = node('div', undefined, axis, 'ticks');
  for (let i = 0; i <= 4; i++) { const tick = node('span', (duration * i / 4000).toFixed(1) + ' s', ticks, 'tick'); tick.style.left = (i * 25) + '%'; }
  for (const [index, a] of activities.entries()) {
    const button = node('button', undefined, list, 'activity ' + a.status);
    button.setAttribute('aria-pressed', 'false'); button.onclick = () => selectActivity(index);
    node('strong', title(a), button);
    node('small', seconds(a.startMs) + ' · ' + (a.durationMs === null ? 'Incomplet' : seconds(a.durationMs)) + ' · ' + statuses[a.status], button);
    if (a.kind === 'tool') node('small', agents[a.agent] ?? a.agent, button);
    node('small', preview(a).slice(0, 240), button, 'preview'); listButtons.push(button);
    const row = node('div', undefined, timeline, 'timeline-row ' + a.status); timelineRows.push(row);
    const label = node('button', a.kind === 'llm' ? (agents[a.agent] ?? a.agent) + ' ' + a.llmNumber : a.label, row, 'timeline-label');
    label.title = title(a); label.onclick = () => selectActivity(index);
    const track = node('div', undefined, row, 'track');
    const bar = node('button', undefined, track, 'bar ' + a.kind + ' ' + a.status);
    bar.style.left = Math.min(99.4, Math.max(0, a.startMs / duration * 100)) + '%';
    bar.style.width = Math.min(100 - Math.max(0, a.startMs / duration * 100), Math.max(.15, (a.durationMs === null ? duration - a.startMs : a.durationMs) / duration * 100)) + '%';
    bar.title = title(a) + ' · ' + seconds(a.startMs) + ' → ' + (a.durationMs === null ? 'incomplet' : seconds(a.startMs + a.durationMs));
    bar.setAttribute('aria-label', bar.title); bar.onclick = () => selectActivity(index);
  }
  pane = 'prompt'; selectActivity(activities.length ? 0 : -1);
}

function renderToolCounts(statistics) {
  const counts = Object.entries(statistics.tools).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  el('tools').replaceChildren(); el('histogram').replaceChildren(); el('histogram-legend').hidden = !counts.length;
  if (!counts.length) { node('p', 'Aucun tool exécuté.', el('histogram'), 'empty'); return; }
  const max = Math.max(1, ...counts.map(([, c]) => c.count));
  const axis = node('div', undefined, el('histogram'), 'histogram-axis');
  node('span', 'Outil', axis); const ticks = node('div', undefined, axis, 'ticks');
  for (const value of [0, max]) node('span', String(value), ticks);
  node('span', 'Appels', axis);
  for (const [name, c] of counts) {
    const row = node('tr', undefined, el('tools'));
    for (const value of [name, c.count, c.failed, seconds(c.durationMs)]) node('td', String(value), row);
    const chartRow = node('div', undefined, el('histogram'), 'histogram-row');
    node('span', name, chartRow);
    const track = node('div', undefined, chartRow, 'histogram-track'); track.setAttribute('aria-hidden', 'true');
    const bar = node('div', undefined, track, 'histogram-bar'); bar.style.width = (c.count / max * 100) + '%';
    const failed = node('div', undefined, bar, 'histogram-failed'); failed.style.width = (c.count ? c.failed / c.count * 100 : 0) + '%';
    node('span', String(c.count) + (c.failed ? ' (' + c.failed + ' err.)' : ''), chartRow);
    chartRow.title = name + ' : ' + c.count + ' appels, ' + c.failed + ' échecs';
  }
}

function showTrial() {
  const trial = data.trials[Number(el('trial').value)];
  if (!trial) { el('outcome').textContent = 'Aucun essai enregistré.'; el('inspector').hidden = true; return; }
  el('inspector').hidden = false;
  const r = trial.result, s = trial.statistics;
  el('outcome').textContent = r.status + (r.error ? ' — ' + r.error : '');
  el('outcome').className = r.status === 'passed' ? '' : 'failed';
  el('metrics').replaceChildren();
  metric(el('metrics'), 'Durée de la demande', seconds(r.durationMs));
  metric(el('metrics'), 'Objectif observé à', r.goalReachedAtMs === null ? '—' : seconds(r.goalReachedAtMs));
  metric(el('metrics'), 'Appels LLM', String(s.llmCalls));
  metric(el('metrics'), 'Tools / échecs', s.toolCalls + ' / ' + s.failedTools);
  metric(el('metrics'), 'Étapes finales cochées', r.final ? r.final.completedSteps + '/' + r.final.planSteps : '—');
  el('criterion').textContent = r.criterion ? r.criterion.expected + ' · ' + r.criterion.actual : '';
  el('files').replaceChildren();
  for (const file of trial.files ?? ['result.json', 'events.jsonl']) {
    const a = node('a', file, el('files'));
    a.href = './' + (trial.directory + '/' + file).split('/').map(encodeURIComponent).join('/');
  }
  renderActivities(trial); renderToolCounts(s);
}

el('campaign').textContent = data.campaignId + ' — rapport enregistré, sans rafraîchissement automatique';
el('campaign-error').textContent = data.error ?? '';
const passed = data.trials.filter(t => t.result.status === 'passed').length;
metric(el('overview'), 'Essais', String(data.trials.length));
metric(el('overview'), 'Réussites', passed + '/' + data.trials.length);
metric(el('overview'), 'Taux de réussite', data.trials.length ? Math.round(passed / data.trials.length * 100) + ' %' : '—');
data.trials.forEach((t, i) => { node('option', (i + 1) + '. ' + t.result.scenario + ' — ' + t.result.status, el('trial')).value = i; });
el('trial').onchange = showTrial;
showTrial();
