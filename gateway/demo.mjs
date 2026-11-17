import { MemoryChain, BsvLedger } from '../research/authority-utxo/bsv.mjs';
const TEST_WORK = (1n << 256n) - 1n; // tests only: accept the easy covenant target
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrivateKey } from '@bsv/sdk';
import { makeUtxo, ROOT_R, announceAndConfirm, covLockingScript } from '../research/authority-utxo/authority/lib/cov/index.mjs';
import { Gateway, MemoryLedger, publicKey, sign, createServer } from './index.mjs';

const key = () => PrivateKey.fromRandom();
const [companyA, companyB, agent1, agent2, gatewayKey] = Array.from({ length: 5 }, key);
const T = Math.floor(Date.now() / 1000) + 3600;
const useBsv = process.argv.includes('--bsv');
const child = (holder, n, v) => ({ holder: publicKey(holder), n, P: 1, T, v });
let ledger, root;
const deposits = [];
if (useBsv) {
  root = makeUtxo({ state: { holder: publicKey(companyA), R: ROOT_R, n: 1000, P: 1, T, d: 0 } });
  async function delegate(utxo, owner, children) {
    const r = await announceAndConfirm(utxo, { key: owner, lockTime: 0, children }, 1);
    assert.equal(r.ok, true, r.error); return r.outputs;
  }
  const [b] = await delegate(root, companyA, [child(companyB, 1000, 1000), child(key(), 0, 0)]);
  const agents = await delegate(b, companyB, [child(agent1, 500, 500), child(agent2, 500, 500)]);
  const chain = new MemoryChain(); ledger = new BsvLedger({ chain, maxTarget: TEST_WORK });
  for (const [i, agent] of [agent1, agent2].entries()) {
    const [bound] = await delegate(agents[i], agent, [child(gatewayKey, 500, 500), child(key(), 0, 0)]);
    // The test adapter explicitly asserts canonical confirmation; no real network.
    deposits.push(chain.put(bound, { confirmations: 1 }));
  }
} else {
  ledger = new MemoryLedger();
  const rootId = ledger.issue({ holder: publicKey(companyA), n: 1000, P: 1, T });
  const b = ledger.delegate(rootId, { key: companyA, children: [child(companyB, 1000)] }).ids[0];
  const agents = ledger.delegate(b, { key: companyB, children: [child(agent1, 500), child(agent2, 500)] }).ids;
  for (const [i, agent] of [agent1, agent2].entries()) {
    deposits.push(ledger.delegate(agents[i], { key: agent, children: [child(gatewayKey, 500)] }).ids[0]);
  }
}
const gateway = new Gateway({ key: gatewayKey, ledger, agentRateLimit: 10000, operations: { 'POST /mock': 1 } });
for (const [i, agent] of [agent1, agent2].entries()) await gateway.bind(deposits[i], [companyA, companyB, agent].map(publicKey));
let calls = 0;
const server = createServer(gateway, { rateLimit: 10000, execute: async () => ({ mock: true, calls: ++calls }) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function send(agent, tranche, path = '/mock') {
  const r = sign(agent, { tranche, method: 'POST', path, body: '{}', nonce: randomUUID() });
  const response = await fetch(base + path, { method: r.method, body: r.body, headers: {
    'X-Tranche': r.tranche, 'X-Agent-Key': r.agentKey, 'X-Nonce': r.nonce, 'X-Agent-Sig': r.signature,
  } });
  const data = await response.json();
  return { status: response.status, data, ms: Number(response.headers.get('x-decision-ms')) };
}
try {
  console.log(`${useBsv ? 'BSVアダプタ（メモリチェーン）' : 'チェーン無し（メモリSQLite）'}`);
  console.log('会社A → 会社B → 子AI1・子AI2（各500回）→ ローカルのモックAPI');
  const samples = [];
  for (let i = 0; i < 260; i++) {
    for (const [j, agent] of [agent1, agent2].entries()) {
      const r = await send(agent, deposits[j]); assert.equal(r.status, 200);
      if (i >= 10) samples.push(r.ms);
    }
  }
  const stopped = await send(companyB, deposits[0], '/stop'); assert.equal(stopped.status, 200);
  const blocked = await send(agent1, deposits[0]); assert.equal(blocked.status, 403);
  const before = gateway.status(deposits[1]).remaining;
  for (let i = 0; i < 3; i++) assert.equal((await send(agent2, deposits[1])).status, 200);
  console.log(`会社Bの署名で子AI1を停止: 次の呼出=${blocked.status}、残数=${gateway.status(deposits[0]).remaining}`);
  console.log(`子AI2は継続: 3回成功、残数 ${before} → ${gateway.status(deposits[1]).remaining}`);
  samples.sort((a, b) => a - b);
  const percentile = p => samples[Math.ceil(samples.length * p) - 1];
  const metrics = { mode: useBsv ? 'bsv' : 'sqlite', samples: samples.length, p50Ms: percentile(0.5), p99Ms: percentile(0.99), scriptBytesK2: root?.script.toBinary().length ?? null,
    scriptBytesK73: root ? covLockingScript(root.state, { K: 73, target: root.params.target }).toBinary().length : null,
    stoppedStatus: blocked.status, siblingCallsAfterStop: 3, mockCalls: calls };
  console.log(`判定時間: p50=${metrics.p50Ms.toFixed(3)}ms / p99=${metrics.p99Ms.toFixed(3)}ms（チェーン待ちなし）`);
  console.log('MEASUREMENTS ' + JSON.stringify(metrics));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  gateway.close();
  ledger.close?.();
}
