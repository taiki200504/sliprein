// Isolated regtest only. Captures SDK-created raw transactions without changing cov code.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Transaction, PrivateKey, UnlockingScript, P2PKH } from '@bsv/sdk';
import { makeUtxo, ROOT_R, deriveR, spendAnnounceUse, spendConfirmUse, spendAnnounceDelegate, spendConfirmDelegate, spendReclaim } from '../lib/cov/index.mjs';
import { chainHeaders, sha256d } from '../lib/cov/headers.mjs';
const container = process.env.REGTEST_CONTAINER;
assert.match(container ?? '', /^authority-regtest-[a-z0-9-]+$/);
function rpc(method, ...args) {
  const p = spawnSync('docker', ['exec', container, 'bitcoin-cli', '-regtest', '-rpcuser=regtest', '-rpcpassword=local-only', method, ...args.map(x => typeof x === 'string' ? x : JSON.stringify(x))], { encoding: 'utf8', maxBuffer: 8e6 });
  if (p.status !== 0) throw new Error(p.stderr.trim() || p.stdout.trim());
  try { return JSON.parse(p.stdout); } catch { return p.stdout.trim(); }
}
assert.equal(rpc('getblockchaininfo').chain, 'regtest');
const rows = [];
const rawById = new Map();
const originalId = Transaction.prototype.id;
Transaction.prototype.id = function (...args) {
  const id = originalId.apply(this, args);
  if (typeof id === 'string') rawById.set(id, this.toHex());
  return id;
};
const target = 0x7fffffn << (8n * (0x20n - 3n)); // regtest nBits 207fffff
const params = { K: 2, target };
const parent = PrivateKey.fromRandom(), owner = PrivateKey.fromRandom(), child = PrivateKey.fromRandom();
const state = { holder: owner.toPublicKey().toString(), R: deriveR(ROOT_R, parent.toPublicKey().toString()), n: 6, P: 1, T: 2_000_000_000, d: 1 };
const mine = n => rpc('generate', n);
function record(name, result, expected) {
  rows.push({ name, ...result, expected, matchesExpectation: result.accepted === expected });
  console.log(JSON.stringify(rows.at(-1)));
}
function broadcast(name, r, expected = true, mineIt = true) {
  assert.equal(r.ok, true, `${name}: SDK ${r.error}`);
  const raw = rawById.get(r.outputs[0].txid);
  assert.ok(raw, 'captured raw transaction');
  const tx = Transaction.fromHex(raw);
  assert.equal(tx.inputs.length, 1);
  const source = rpc('gettxout', tx.inputs[0].sourceTXID, tx.inputs[0].sourceOutputIndex);
  const feeSatoshis = source ? Math.round(source.value * 1e8) - tx.outputs.reduce((sum, x) => sum + x.satoshis, 0) : null;
  if (source) assert.equal(feeSatoshis, 0);
  let result;
  try {
    const txid = rpc('sendrawtransaction', raw);
    result = { sdk: true, accepted: true, txid };
    if (mineIt) {
      const hash = mine(1)[0];
      result.block = hash;
      result.included = rpc('getblock', hash).tx.includes(txid);
      assert.equal(result.included, true);
    }
  } catch (e) { result = { sdk: true, accepted: false, error: e.message }; }
  record(name, { ...result, inputs: tx.inputs.length, feeSatoshis }, expected);
  return result;
}
function fund(name) {
  const coin = rpc('listunspent', 100).find(x => x.amount > 1);
  assert.ok(coin, 'mature regtest coin');
  const u = makeUtxo({ state, satoshis: 10000, params });
  const change = new P2PKH().lock(rpc('getnewaddress'));
  const tx = new Transaction(1, [{ sourceTXID: coin.txid, sourceOutputIndex: coin.vout, unlockingScript: UnlockingScript.fromASM(''), sequence: 0xffffffff }], [
    { satoshis: u.satoshis, lockingScript: u.script },
    { satoshis: Math.round(coin.amount * 1e8) - u.satoshis - 1000, lockingScript: change },
  ], 0);
  const signed = rpc('signrawtransaction', tx.toHex());
  assert.equal(signed.complete, true);
  u.txid = rpc('sendrawtransaction', signed.hex);
  const block = mine(1)[0];
  assert.ok(rpc('getblock', block).tx.includes(u.txid));
  record(name, { accepted: true, txid: u.txid, block, included: true }, true);
  return u;
}
function proof(txid, blockHash) {
  const b = rpc('getblock', blockHash);
  const index = b.tx.indexOf(txid);
  assert.ok(index >= 0);
  let level = b.tx.map(id => Buffer.from(id, 'hex').reverse()), pos = index;
  const siblings = [];
  while (level.length > 1) {
    if (level.length % 2) level.push(level.at(-1));
    siblings.push(level[pos ^ 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(Buffer.concat(level.slice(i, i + 2))));
    pos >>= 1; level = next;
  }
  const following = mine(2);
  const headers = [blockHash, ...following].map(h => Buffer.from(rpc('getblockheader', h, false), 'hex'));
  assert.equal(headers[0].readUInt32LE(72), 0x207fffff);
  return { headers, merkleProof: { index, siblings } };
}
const spec = { key: owner, lockTime: 0 };
try {
  mine(105);
  const u = fund('issue-use');
  const a = await spendAnnounceUse(u, spec);
  const ar = broadcast('announce-use', a);
  if (ar.accepted) {
    const witness = proof(a.outputs[0].txid, ar.block);
    const c = await spendConfirmUse(a.outputs[0], { ...spec, ...witness });
    const reclaim = await spendReclaim(a.outputs[0], { key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 });
    broadcast('confirm-use-real-headers', c);
    broadcast('double-spend-after-confirm', reclaim, false);
  }
  const u2 = fund('issue-reclaim');
  const a2 = await spendAnnounceUse(u2, spec);
  const a2r = broadcast('announce-reclaim', a2);
  if (a2r.accepted) {
    const witness = proof(a2.outputs[0].txid, a2r.block);
    const c = await spendConfirmUse(a2.outputs[0], { ...spec, ...witness });
    const r = await spendReclaim(a2.outputs[0], { key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 });
    broadcast('ancestor-reclaim', r);
    broadcast('confirm-after-reclaim', c, false);
  }
  const u3 = fund('issue-delegate');
  const children = [ { holder: child.toPublicKey().toString(), n: 2, P: 1, T: state.T, v: 5000 }, { holder: owner.toPublicKey().toString(), n: 2, P: 1, T: state.T, v: 5000 } ];
  const ds = { ...spec, children };
  const a3 = await spendAnnounceDelegate(u3, ds);
  const a3r = broadcast('announce-delegate', a3);
  if (a3r.accepted) {
    const d = await spendConfirmDelegate(a3.outputs[0], { ...ds, ...proof(a3.outputs[0].txid, a3r.block) });
    const dr = broadcast('confirm-delegate-real-headers', d);
    if (dr.accepted) {
      const cs = { key: child, lockTime: 0 };
      const ca = await spendAnnounceUse(d.outputs[0], cs);
      const car = broadcast('child-announce', ca);
      if (car.accepted) broadcast('child-use-real-headers', await spendConfirmUse(ca.outputs[0], { ...cs, ...proof(ca.outputs[0].txid, car.block) }));
    }
  }
  const race = fund('issue-mempool-race');
  const ra = await spendAnnounceUse(race, spec);
  const rar = broadcast('announce-mempool-race', ra);
  if (rar.accepted) {
    const rc = await spendConfirmUse(ra.outputs[0], { ...spec, ...proof(ra.outputs[0].txid, rar.block) });
    const rr = await spendReclaim(ra.outputs[0], { key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 });
    const accepted = broadcast('confirm-in-mempool', rc, true, false);
    if (accepted.accepted) {
      broadcast('reclaim-conflicts-with-mempool-confirm', rr, false, false);
      const hash = mine(1)[0];
      assert.ok(rpc('getblock', hash).tx.includes(rc.outputs[0].txid));
      rows.find(x => x.name === 'confirm-in-mempool').included = true;
      rows.find(x => x.name === 'confirm-in-mempool').block = hash;
    }
  }
  const u4 = fund('issue-floating');
  const a4 = await spendAnnounceUse(u4, spec);
  const a4r = broadcast('announce-floating', a4);
  if (a4r.accepted) {
    const headers = chainHeaders(3, Buffer.from(a4.outputs[0].txid, 'hex').reverse().toString('hex'), 1700000000, target);
    for (const h of headers) {
      let known = false;
      try { rpc('getblockheader', Buffer.from(sha256d(h)).reverse().toString('hex')); known = true; } catch {}
      assert.equal(known, false, 'floating header must be unknown to node');
    }
    broadcast('floating-headers-confirm', await spendConfirmUse(a4.outputs[0], { ...spec, headers }), false);
  }
} finally {
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({ network: 'regtest', image: 'bitcoinsv/bitcoin-sv@sha256:d96fe4786a00e5fc10bc9e0e76a6006376f9472d4eb74d07e4c1e0d019493d33', sdkVersion: JSON.parse(readFileSync(new URL('../../package.json', import.meta.resolve('@bsv/sdk')))).version, version: rpc('getnetworkinfo'), params: { K: 2, target: target.toString(16), bits: '207fffff' }, rows }, null, 2) + '\n');
}

// A completed run is not a security pass: unmet requested expectations return 2.
if (rows.some(r => !r.matchesExpectation)) process.exitCode = 2;
