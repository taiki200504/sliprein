import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chainHeaders } from './lib/cov/headers.mjs';
import { PrivateKey } from '@bsv/sdk';
import { makeUtxo, ROOT_R, announceAndConfirm, spendReclaim, deriveR } from './lib/cov/index.mjs';
import { covLockingScript, compactSize, u32le } from './lib/cov/script.mjs';
const owner = PrivateKey.fromRandom();
const parent = PrivateKey.fromRandom();
const state = { holder: owner.toPublicKey().toString(), R: deriveR(ROOT_R, parent.toPublicKey().toString()), n: 3, P: 1, T: 2_000_000_000, d: 1 };
const target = (1n << 255n) - 1n;
test('v04 issuance rejects invalid K and unsigned target', () => {
  for (const K of [0, 513, 1.5, NaN]) assert.throws(() => covLockingScript(state, { K, target }));
  for (const t of [0n, -1n, 1n << 256n, 'ff', 1]) assert.throws(() => covLockingScript(state, { K: 2, target: t }));
});
test('v04 K=1 and K=73 validate full confirmation; successor inherits code', async () => {
  for (const K of [1, 2, 73]) {
    const u = makeUtxo({ state, params: { K, target } });
    const r = await announceAndConfirm(u, { key: owner, lockTime: 0 });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.outputs[0].params, u.params);
    console.log(JSON.stringify({ K, scriptBytes: r.scriptSize, validateMs: r.validateMs }));
    const back = await spendReclaim(r.outputs[0], { key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 });
    assert.equal(back.ok, true, back.error);
    assert.deepEqual(back.outputs[0].params, u.params);
  }
});
test('v04 K=512 issuance supports CompactSize beyond uint16', () => {
  assert.ok(covLockingScript(state, { K: 512, target }).toBinary().length > 65535);
});
test('v04 reclaim cannot weaken K or target', async () => {
  const u = makeUtxo({ state, params: { K: 3, target } });
  for (const params of [{ K: 2, target }, { K: 3, target: (1n << 256n) - 1n }]) {
    const r = await spendReclaim(u, { key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0,
      tamper: (o) => o.map(x => ({ ...x, params })) });
    assert.equal(r.ok, false);
    assert.equal(r.failedRule, 'hashOutputs');
  }
});
test('v04 K=512 large script validates announcement and reclaim', async () => {
  const u = makeUtxo({ state, params: { K: 512, target } });
  const { spendAnnounceUse } = await import('./lib/cov/index.mjs');
  const a = await spendAnnounceUse(u, { key: owner, lockTime: 0 });
  assert.equal(a.ok, true, a.error);
  const confirmed = await announceAndConfirm(u, { key: owner, lockTime: 0 });
  assert.equal(confirmed.ok, true, confirmed.error);
  const r = await spendReclaim(a.outputs[0], { key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 });
  assert.equal(r.ok, true, r.error);
});

test('v04 K=73 requires every header and link', async () => {
  const { spendAnnounceUse, spendConfirmUse } = await import('./lib/cov/index.mjs');
  const u = makeUtxo({ state, params: { K: 73, target } });
  const a = await spendAnnounceUse(u, { key: owner, lockTime: 0 });
  assert.equal(a.ok, true, a.error);
  const pending = a.outputs[0];
  const headers = chainHeaders(74, Buffer.from(pending.txid, 'hex').reverse().toString('hex'), 1, target);
  const r = await spendConfirmUse(pending, { key: owner, lockTime: 0, headers: headers.slice(0, 73) });
  assert.equal(r.ok, false); assert.equal(r.failedRule, 'headers:size');
  const broken = [...headers]; broken[73] = headers[72];
  const b = await spendConfirmUse(pending, { key: owner, lockTime: 0, headers: broken });
  assert.equal(b.ok, false); assert.equal(b.failedRule, 'headers:link');
});
test('v04 precommitted child parameter downgrade fails code equality', async () => {
  const { spendAnnounce, spendConfirmDelegate, intentHash } = await import('./lib/cov/index.mjs');
  const params = { K: 3, target };
  const u = makeUtxo({ state, params });
  const children = [1, 2].map(n => ({ holder: owner.toPublicKey().toString(), n, P: 1, T: state.T, v: 500 }));
  for (const weak of [{ K: 2, target }, { K: 3, target: (1n << 256n) - 1n }]) {
    const desc = children.map(c => ({ satoshis: c.v, params: weak, state: { ...state, holder: c.holder, R: deriveR(state.R, state.holder), n: c.n, d: 2, phase: 0, intent: '00'.repeat(32) } }));
    desc.push({ satoshis: 0, burn: 0 });
    const bytes = desc.map(o => {
      const sc = o.state ? Buffer.from(covLockingScript(o.state, o.params).toBinary()) : Buffer.from(`006a04${u32le(o.burn)}`, 'hex');
      const value = Buffer.alloc(8); value.writeBigUInt64LE(BigInt(o.satoshis));
      return Buffer.concat([value, compactSize(sc.length), sc]);
    });
    const hash = b => createHash('sha256').update(b).digest();
    const intent = hash(hash(Buffer.concat(bytes))).toString('hex');
    assert.notEqual(intent, intentHash(u, { children }, 1));
    const a = await spendAnnounce(u, { key: owner, lockTime: 0, intent });
    assert.equal(a.ok, true, a.error);
    const pending = a.outputs[0];
    const headers = chainHeaders(4, Buffer.from(pending.txid, 'hex').reverse().toString('hex'), 1, target);
    const r = await spendConfirmDelegate(pending, { key: owner, lockTime: 0, children, headers, tamper: () => desc });
    assert.equal(r.ok, false); assert.equal(r.failedRule, 'hashOutputs');
  }
});
