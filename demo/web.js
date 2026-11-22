const $ = id => document.getElementById(id);
function render({ agents, log }) {
  const rows = $('rows'); rows.replaceChildren();
  for (const a of agents) {
    const tr = document.createElement('tr'); if (a.stopped) tr.className = 'stopped';
    for (const v of [a.agent, a.remaining, a.used, a.stopped ? 'stopped' : 'active']) { const td = document.createElement('td'); td.textContent = String(v); tr.append(td); }
    rows.append(tr);
  }
  $('sum').textContent = String(agents.reduce((s, a) => s + a.remaining + a.used, 0));
  // Expected "not possible now" actions are disabled with a reason instead of being sent.
  const byName = new Map(agents.map(a => [a.agent, a]));
  const agent2 = byName.get('agent-2'), delegateDone = byName.has('worker') || !agent2 || agent2.stopped;
  document.querySelector('button[data-act="delegate"]').disabled = delegateDone;
  $('why-delegate').textContent = !delegateDone ? '' : byName.has('worker') ? 'already delegated — Reset to try again' : 'agent-2 is stopped — Reset to try again';
  for (const b of document.querySelectorAll('button[data-agent]')) b.disabled = !byName.has(b.dataset.agent);
  $('log').textContent = log.join('\n');
}
async function act(button) {
  const { act, agent } = button.dataset;
  const body = act === 'delegate' ? { from: 'agent-2', name: 'worker', calls: 20 } : act === 'reset' ? {} : { agent };
  const res = await fetch(`/api/${act}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  $('status').textContent = res.ok ? `HTTP ${json.result}${json.result === 200 ? '' : ' — denied by the gateway'}` : 'Not possible now (already done or unknown agent). Try Reset.';
  if (json.agents) render(json);
}
document.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => act(b)));
fetch('/api/state').then(r => r.json()).then(render);
