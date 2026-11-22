import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startWebDemo } from './web.mjs';

const TOKEN = /[A-Za-z0-9_-]{43}/;

test('web demo: split, re-delegate, stop, deny and reclaim once through the real gateway HTTP', async () => {
  const demo = await startWebDemo();
  const origin = new URL(demo.url).origin;
  const post = (path, body, headers = {}) => fetch(new URL(path, demo.url), { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch(new URL('/api/state', demo.url))).json()).agents;
  const row = (agents, name) => agents.find(a => a.agent === name);
  const total = agents => agents.reduce((s, a) => s + a.remaining + a.used, 0);
  const directory = demo.directory;
  try {
    let agents = await state();
    assert.equal(row(agents, 'coordinator').remaining, 0);
    for (const n of [1, 2, 3]) assert.equal(row(agents, `agent-${n}`).remaining, 50);
    assert.equal(total(agents), 150);

    let r = await (await post('/api/delegate', { from: 'agent-2', name: 'worker', calls: 20 })).json();
    assert.equal(r.result, 200);
    assert.equal(row(r.agents, 'agent-2').remaining, 30);
    assert.equal(row(r.agents, 'worker').remaining, 20);
    assert.equal(total(r.agents), 150);
    const greedy = await (await post('/api/delegate', { from: 'worker', name: 'greedy', calls: 999 })).json();
    assert.notEqual(greedy.result, 200, 'a child cannot delegate more than it holds');
    assert.ok(!(await state()).some(a => a.agent === 'greedy'));
    assert.equal(total(await state()), 150);

    assert.equal((await (await post('/api/call', { agent: 'worker' })).json()).result, 200);
    r = await (await post('/api/stop', { agent: 'agent-2' })).json();
    assert.equal(r.result, 200);
    assert.ok(row(r.agents, 'agent-2').stopped && row(r.agents, 'worker').stopped);
    assert.equal(row(r.agents, 'coordinator').remaining, 30 + 19, 'unused calls of the subtree return to the parent');
    assert.ok(total(r.agents) <= 150);

    for (const agent of ['agent-2', 'worker']) assert.notEqual((await (await post('/api/call', { agent })).json()).result, 200, `${agent} is denied`);
    assert.equal((await (await post('/api/call', { agent: 'agent-1' })).json()).result, 200, 'siblings keep running');

    await post('/api/stop', { agent: 'agent-2' });
    agents = await state();
    assert.equal(row(agents, 'coordinator').remaining, 49, 'reclaim happens once');
    assert.ok(total(agents) <= 150);

    const page = await (await fetch(demo.url)).text();
    const json = JSON.stringify(await (await fetch(new URL('/api/state', demo.url))).json());
    assert.ok(!TOKEN.test(page) && !TOKEN.test(json), 'tokens never leave the server');
  } finally { await demo.close(); }
  assert.equal(existsSync(directory), false, 'temporary state removed on close');
});

test('web demo: rejects cross-origin writes, foreign Host (DNS rebinding) and unknown agents', async () => {
  const demo = await startWebDemo();
  const origin = new URL(demo.url).origin;
  try {
    const evil = await fetch(new URL('/api/stop', demo.url), { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{"agent":"agent-1"}' });
    assert.equal(evil.status, 403);
    const form = await fetch(new URL('/api/stop', demo.url), { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{"agent":"agent-1"}' });
    assert.equal(form.status, 403);
    const noOrigin = await fetch(new URL('/api/stop', demo.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"agent":"agent-1"}' });
    assert.equal(noOrigin.status, 403);
    const { request } = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const u = new URL(demo.url);
      request({ host: u.hostname, port: u.port, path: '/api/state', headers: { host: `attacker.example:${u.port}` } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
    });
    assert.equal(status, 421);
    const unknown = await fetch(new URL('/api/call', demo.url), { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"agent":"nobody"}' });
    assert.equal(unknown.status, 400);
    const agents = (await (await fetch(new URL('/api/state', demo.url))).json()).agents;
    assert.equal(agents.find(a => a.agent === 'agent-1').stopped, 0, 'nothing was stopped by rejected requests');
  } finally { await demo.close(); }
});

test('web demo: survives reset racing state reads and an aborted request body, then cleans up', async () => {
  const demo = await startWebDemo();
  const origin = new URL(demo.url).origin;
  const errors = [];
  const onError = e => errors.push(e);
  process.on('unhandledRejection', onError); process.on('uncaughtException', onError);
  try {
    const reset = () => fetch(new URL('/api/reset', demo.url), { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    const read = () => fetch(new URL('/api/state', demo.url)).then(r => r.status);
    const results = await Promise.all([reset(), ...Array.from({ length: 20 }, read), reset(), ...Array.from({ length: 20 }, read)]);
    for (const r of results.slice(1)) if (typeof r === 'number') assert.equal(r, 200);
    const { request } = await import('node:http');
    const u = new URL(demo.url);
    await new Promise(resolve => {
      const req = request({ host: u.hostname, port: u.port, path: '/api/call', method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': '500' } });
      req.on('error', () => resolve()); req.write('{"agent":"age'); setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await read(), 200, 'server still alive');
    assert.deepEqual(errors, []);
  } finally {
    process.off('unhandledRejection', onError); process.off('uncaughtException', onError);
    const directory = demo.directory; await demo.close(); assert.equal(existsSync(directory), false);
  }
});
