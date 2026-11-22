// Local browser demo: split a budget, re-delegate, stop a branch, see denial and reclaim.
// Every action goes through the real proxy HTTP API (/delegate, /stop, /v1/chat/completions)
// against a mock upstream. No external network, no API key. Tokens stay in this process.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState } from '../gateway/cli/state.mjs';
import { createProxyServer } from '../gateway/proxy.mjs';

const PAGE = readFileSync(new URL('./web.html', import.meta.url));
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); });
const shut = server => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

async function startScenario() {
  const directory = mkdtempSync(join(tmpdir(), 'sliprein-web-demo-'));
  const servers = [];
  let state;
  try {
    state = openState(directory);
    return await build(directory, state, servers);
  } catch (error) {
    for (const server of servers) if (server.listening) await shut(server);
    state?.close(); rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function build(directory, state, servers) {
  const upstream = createServer(async (req, res) => {
    try { for await (const _ of req) { /* drain */ } } catch { return res.destroy(); } // proxy may abort the upstream request
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'mock', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  servers.push(upstream);
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(state.gateway, { upstream: `http://127.0.0.1:${upstreamPort}`, apiKey: 'demo-only-mock-key', control: state });
  servers.push(proxy);
  const proxyPort = await listen(proxy);
  const tokens = new Map();
  const call = async (path, token, body) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* upstream body */ }
    return { status: res.status, json };
  };
  const scenario = {
    async delegate(from, name, calls) {
      const r = await call('/delegate', tokens.get(from), { name, calls });
      if (r.status === 200 && r.json?.token) tokens.set(name, r.json.token);
      return { status: r.status };
    },
    async request(agent) { return { status: (await call('/v1/chat/completions', tokens.get(agent), { model: 'mock', messages: [{ role: 'user', content: 'continue' }] })).status }; },
    async stop(agent) { return { status: (await call('/stop', tokens.get(agent), {})).status }; },
    has: name => tokens.has(name),
    status: () => state.status(),
    async close() { await shut(proxy); await shut(upstream); state.close(); rmSync(directory, { recursive: true, force: true }); },
    directory,
  };
  state.issue('coordinator', { n: 150 });
  tokens.set('coordinator', state.token('coordinator'));
  for (let i = 1; i <= 3; i++) await scenario.delegate('coordinator', `agent-${i}`, 50);
  return scenario;
}

export async function startWebDemo({ port = 0 } = {}) {
  let scenario = await startScenario(), log = ['coordinator: 150 calls split into agent-1/2/3 × 50 (POST /delegate)'], busy = Promise.resolve();
  const server = createServer((req, res) => handle(req, res).catch(() => {
    // Never let a request error (client abort, closed state) crash the demo or skip cleanup.
    if (res.headersSent) res.destroy(); else { res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"demo error"}'); }
  }));
  async function handle(req, res) {
    const origin = `http://${req.headers.host}`;
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    // DNS rebinding: only our own loopback host names.
    if (!allowedHosts.has(req.headers.host ?? '')) return send(421, { error: 'host not allowed' });
    if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/web.js') return send(200, readFileSync(new URL('./web.js', import.meta.url)), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/state') return send(200, { agents: scenario.status(), log });
    if (req.method !== 'POST' || !req.url.startsWith('/api/')) return send(404, { error: 'not found' });
    // Cross-origin writes: require our own Origin and a JSON body (forces a CORS preflight we never answer).
    if (req.headers.origin !== origin || !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(403, { error: 'cross-origin request rejected' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1024) return send(413, { error: 'too large' }); }
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'invalid JSON' }); }
    const known = name => typeof name === 'string' && NAME.test(name) && scenario.has(name);
    const run = async () => {
      if (req.url === '/api/reset') {
        // Build the new ledger first, swap, then close the old one: readers never see a closed database.
        const next = await startScenario(), old = scenario;
        scenario = next; log = ['reset: coordinator 150 → 50 / 50 / 50'];
        await old.close(); return { status: 200 };
      }
      if (req.url === '/api/delegate') {
        const calls = Number(body.calls);
        if (!known(body.from) || typeof body.name !== 'string' || !NAME.test(body.name) || scenario.has(body.name) || !Number.isInteger(calls) || calls < 1 || calls > 1000) return { status: 400 };
        const r = await scenario.delegate(body.from, body.name, calls); log.push(`${body.from} delegated ${calls} calls to ${body.name}: HTTP ${r.status}`); return r;
      }
      if (!known(body.agent)) return { status: 400 };
      if (req.url === '/api/call') { const r = await scenario.request(body.agent); log.push(`${body.agent} called the API: HTTP ${r.status}${r.status === 200 ? '' : ' (denied)'}`); return r; }
      if (req.url === '/api/stop') { const r = await scenario.stop(body.agent); log.push(`${body.agent} subtree stopped (POST /stop): HTTP ${r.status}`); return r; }
      return { status: 404 };
    };
    // Serialise actions so the log and the ledger read in order.
    const result = busy.then(run); busy = result.catch(() => {});
    const r = await result; log = log.slice(-50);
    return send(r.status === 404 || r.status === 400 ? r.status : 200, { result: r.status, agents: scenario.status(), log });
  }
  const actual = await listen(server, port);
  const allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
  return {
    url: `http://127.0.0.1:${actual}/`,
    get directory() { return scenario.directory; },
    async close() { await shut(server); await busy; await scenario.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = await startWebDemo({ port: Number(process.env.PORT ?? 8790) });
  console.log(`sliprein web demo: ${demo.url}  (Ctrl+C stops it and deletes the temporary state)`);
  const stop = async () => { await demo.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
