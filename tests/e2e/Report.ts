import type { Statistics } from "./Statistics";
import type { TrialResult } from "./types";

export interface ReportTrial { directory: string; result: TrialResult; statistics: Statistics; files?: string[] }

/** Standalone, local HTML. No server, automatic refresh, CDN or external dependencies. */
export function renderReport(campaignId: string, trials: readonly ReportTrial[], error?: string): string {
  const payload = JSON.stringify({ campaignId, trials, error }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campagne Minecraft</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111820;color:#e7eef5}body{max-width:1200px;margin:35px auto;padding:0 24px}h1{font-size:28px}h2{font-size:20px;margin-top:32px}.muted{color:#a5b5c7}select,button{font:inherit;background:#213244;color:inherit;border:1px solid #546a82;padding:10px;border-radius:6px}select{max-width:100%}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{padding:16px;background:#1b2938;border-radius:8px;min-width:145px}.number{font-size:25px;display:block}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #344455}.timeline{overflow:auto}.row{display:grid;grid-template-columns:235px minmax(300px,1fr);gap:12px;align-items:center;min-height:32px}.row button{text-align:left;font-size:12px;padding:5px}.track{height:17px;background:#1a2735;border-radius:3px;position:relative}.bar{position:absolute;height:100%;min-width:3px;background:#49b39b;border-radius:3px}.bar.llm{background:#6389df}.bar.failed{background:#e46b73}.bar.incomplete{background:#e0b562}.failed{color:#ff9ca3}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1b2938;padding:18px;border-radius:8px}a{color:#99c2ff}.status{font-weight:600}
</style><h1>Campagne Minecraft</h1><p id="campaign" class="muted"></p><p id="campaign-error" class="failed"></p><p><a href="events.jsonl">Événements de campagne</a> · <a href="campaign.json">Configuration</a></p><div id="overview" class="cards"></div>
<h2>Essai</h2><select id="trial" aria-label="Choisir un essai"></select><p id="outcome"></p><div id="metrics" class="cards"></div>
<p id="criterion"></p><p id="files"></p><h2>Timeline</h2><p class="muted">Temps depuis la prise en charge · bleu : LLM · vert : tool · rouge : erreur · jaune : appel incomplet. Les délégations englobent leurs tools : leurs durées ne s’additionnent pas.</p><div id="timeline" class="timeline"></div>
<h2>Détail sélectionné</h2><pre id="detail">Cliquez sur un appel.</pre><h2>Appels par tool</h2><table><thead><tr><th>Tool</th><th>Appels</th><th>Échecs</th><th>Durée cumulée</th></tr></thead><tbody id="tools"></tbody></table>
<script id="data" type="application/json">${payload}</script><script>
const data=JSON.parse(document.getElementById('data').textContent);const el=id=>document.getElementById(id);const seconds=ms=>(ms/1000).toFixed(2)+' s';
function node(tag,text,parent){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.append(n);return n;}
function card(parent,label,value){const box=node('div',undefined,parent);box.className='card';node('span',value,box).className='number';node('span',label,box);}
el('campaign').textContent=data.campaignId+' — rapport enregistré, sans rafraîchissement automatique';
el('campaign-error').textContent=data.error||'';
const passed=data.trials.filter(t=>t.result.status==='passed').length;card(el('overview'),'Essais',String(data.trials.length));card(el('overview'),'Réussites',passed+'/'+data.trials.length);card(el('overview'),'Taux de réussite',data.trials.length?Math.round(passed/data.trials.length*100)+' %':'—');
data.trials.forEach((t,i)=>{const o=node('option',(i+1)+'. '+t.result.scenario+' — '+t.result.status,el('trial'));o.value=i;});
function show(){const trial=data.trials[Number(el('trial').value)];if(!trial)return;const r=trial.result,s=trial.statistics;
el('outcome').textContent=r.status+(r.error?' — '+r.error:'');el('outcome').className=r.status==='passed'?'status':'status failed';el('metrics').replaceChildren();card(el('metrics'),'Durée de la demande',seconds(r.durationMs));card(el('metrics'),'Objectif observé à',r.goalReachedAtMs===null?'—':seconds(r.goalReachedAtMs));card(el('metrics'),'Appels LLM',String(s.llmCalls));card(el('metrics'),'Tools / échecs',s.toolCalls+' / '+s.failedTools);card(el('metrics'),'Étapes finales cochées',r.final?r.final.completedSteps+'/'+r.final.planSteps:'—');
el('criterion').textContent=r.criterion?r.criterion.expected+' · '+r.criterion.actual:'';el('files').replaceChildren();for(const file of trial.files||['result.json','events.jsonl']){const a=node('a',file,el('files'));a.href=trial.directory+'/'+file;el('files').append('  ');}
el('timeline').replaceChildren();const duration=Math.max(1,r.durationMs,...s.activities.map(a=>a.startMs+(a.durationMs||0)));for(const a of s.activities){const row=node('div',undefined,el('timeline'));row.className='row';const button=node('button',a.agent+' · '+a.label,row);button.onclick=()=>{el('detail').textContent=JSON.stringify(a,null,2);};const track=node('div',undefined,row);track.className='track';const bar=node('div',undefined,track);bar.className='bar '+a.kind+' '+a.status;bar.style.left=Math.max(0,a.startMs/duration*100)+'%';bar.style.width=Math.min(100,Math.max(.15,(a.durationMs===null?duration-a.startMs:a.durationMs)/duration*100))+'%';bar.title=seconds(a.startMs)+' → '+(a.durationMs===null?'incomplet':seconds(a.startMs+a.durationMs));}
el('tools').replaceChildren();for(const [name,counts] of Object.entries(s.tools)){const row=node('tr',undefined,el('tools'));for(const value of [name,counts.count,counts.failed,seconds(counts.durationMs)])node('td',String(value),row);}
el('detail').textContent=JSON.stringify({initial:r.initial,final:r.final,forcedShutdown:r.forcedShutdown},null,2);}
el('trial').onchange=show;show();
</script></html>`;
}
