// v0.3 赤チーム。@bsv/sdk の Spend.validate だけ。取引は組み立てて評価し、送らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrivateKey, LockingScript } from '@bsv/sdk';
import {
  ROOT_R, deriveR, makeUtxo, spendAnnounce, spendAnnounceUse, spendAnnounceDelegate,
  spendConfirmUse, spendConfirmDelegate, spendReclaim, intentHash,
} from './lib/cov/index.mjs';
import { PATH, covLockingScript, u32le } from './lib/cov/script.mjs';
import { assembleHeader, headerHashLE, sha256d, TEST_TARGET } from './lib/cov/headers.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest();
const key = () => PrivateKey.fromRandom();
const pk = (k) => k.toPublicKey().toString();
const T = 2_000_000_000;
const ZERO = '00'.repeat(32);
// WhatsOnChain block 975655 (2026-11-16 取得). bits はヘッダの難易度フィールド。
const MAINNET_BITS = 0x18225459;
const MAINNET_TARGET = bitsToTarget(BigInt(MAINNET_BITS));

const show = (r) => JSON.stringify({ ok: r.ok, rule: r.failedRule, error: r.error?.slice(0, 160), lockTime: r.lockTime });
async function mustOk(p) {
  const r = await p;
  assert.equal(r.ok, true, show(r));
  return r;
}
async function mustFail(p, rule) {
  const r = await p;
  assert.equal(r.ok, false, show(r));
  assert.equal(r.failedRule, rule, show(r));
  return r;
}

function bitsToTarget(bits) {
  const exp = Number((bits >> 24n) & 0xffn);
  const mant = bits & 0xffffffn;
  if (exp <= 3) return mant >> BigInt(8 * (3 - exp));
  return mant << BigInt(8 * (exp - 3));
}
function internalTxid(displayHex) {
  return Buffer.from(displayHex, 'hex').reverse().toString('hex');
}
function mineCounted(fields, maxTries = 5_000_000) {
  const partial = assembleHeader({ ...fields, nonce: 0 });
  for (let nonce = 0; nonce < maxTries; nonce++) {
    partial.writeUInt32LE(nonce >>> 0, 76);
    if (headerHashLE(partial) <= TEST_TARGET) return { header: Buffer.from(partial), nonce, tries: nonce + 1 };
  }
  throw new Error('mineCounted: nonce not found');
}
function fakeChain(merkleHex, times = [1, 1, 1], bits = MAINNET_BITS) {
  const headers = [];
  const tries = [];
  let prev = ZERO;
  for (let i = 0; i < times.length; i++) {
    const hit = mineCounted({ prevHex: prev, merkleHex, time: times[i], bits });
    headers.push(hit.header);
    tries.push(hit.tries);
    prev = sha256d(hit.header).toString('hex');
  }
  return { headers, tries, total: tries.reduce((a, b) => a + b, 0) };
}
function fresh(owner, patch = {}, params) {
  return makeUtxo({ params, state: { holder: pk(owner), R: ROOT_R, n: 3, P: 1, T, d: 0, ...patch } });
}
function scriptOfDesc(o) {
  if (o.burn !== undefined) return LockingScript.fromHex(`006a04${u32le(o.burn)}`);
  if (o.codeSwap) {
    const first = covLockingScript(o.state).toASM().split(' ')[0];
    return LockingScript.fromASM(`${first} OP_DROP OP_1`);
  }
  return covLockingScript(o.state);
}
function hashOutputs(descs) {
  const bytes = descs.map((o) => {
    const sc = Buffer.from(scriptOfDesc(o).toBinary());
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(BigInt(o.satoshis));
    const len = sc.length < 253 ? Buffer.from([sc.length]) : Buffer.from([0xfd, sc.length & 0xff, (sc.length >> 8) & 0xff]);
    return Buffer.concat([value, len, sc]);
  });
  return sha256(sha256(Buffer.concat(bytes))).toString('hex');
}
const child = (k, n, v = 500) => ({ holder: pk(k), n, P: 1, T, v });

const attacks = new Map();
async function attackFixture(mainnet = false) {
  if (attacks.has(mainnet)) return attacks.get(mainnet);
  const owner = key();
  const parent = key();
  const root = fresh(owner, { R: deriveR(ROOT_R, pk(parent)), d: 1 }, mainnet ? { K: 2, target: MAINNET_TARGET } : undefined);
  const announced = await mustOk(spendAnnounceUse(root, { key: owner, lockTime: 0 }));
  const utxo = announced.outputs[0];
  const chain = fakeChain(internalTxid(utxo.txid));
  const attack = { owner, parent, root, announced, utxo, chain };
  attacks.set(mainnet, attack);
  return attack;
}

test('R2-S serializer matches intentHash', () => {
  const owner = key();
  const u = fresh(owner);
  const manual = hashOutputs([{
    satoshis: u.satoshis,
    state: { ...u.state, n: u.state.n - 1, phase: 0, intent: ZERO },
  }]);
  assert.equal(manual, intentHash(u, {}, PATH.USE));
});

test('R2-A mainnet-target issuance rejects easy floating headers despite mainnet bits', async () => {
  const { owner, utxo, chain } = await attackFixture(true);
  for (const h of chain.headers) {
    assert.equal(h.readUInt32LE(72), MAINNET_BITS);
    assert.ok(headerHashLE(h) <= TEST_TARGET);
    assert.ok(headerHashLE(h) > MAINNET_TARGET);
  }
  await mustFail(spendConfirmUse(utxo, { key: owner, lockTime: 0, headers: chain.headers }), 'headers:work');
});

test('R2-A header time high bit does not skip expiry', async () => {
  const { owner, utxo } = await attackFixture();
  const chain = fakeChain(internalTxid(utxo.txid), [1, 1, 0x80000000]);
  await mustFail(spendConfirmUse(utxo, { key: owner, lockTime: 0, headers: chain.headers }), 'headers:expiry');
});

test('R2-B 4-leaf proof, wrong index, 64-byte sibling', async () => {
  const { owner, utxo } = await attackFixture();
  const txid = Buffer.from(utxo.txid, 'hex').reverse();
  const s1 = Buffer.from('11'.repeat(32), 'hex');
  const s2 = Buffer.from('22'.repeat(32), 'hex');
  const s3 = Buffer.from('33'.repeat(32), 'hex');
  const n23 = sha256d(Buffer.concat([s2, s3]));
  const root = sha256d(Buffer.concat([sha256d(Buffer.concat([txid, s1])), n23]));
  const chain = fakeChain(root.toString('hex'));
  const prove = (siblings, index) => spendConfirmUse(utxo, {
    key: owner, lockTime: 0, headers: chain.headers, merkleProof: { siblings, index },
  });
  await mustOk(prove([s1, n23], 0));
  await mustOk(prove([s1, Buffer.alloc(0), n23], 0));
  await mustFail(prove([s1, n23], 1), 'merkle');
  await mustFail(prove([s1, n23], 2), 'merkle');
  await mustFail(prove([n23], 0), 'merkle');
  await mustFail(prove([Buffer.concat([s1, n23])], 0), 'merkle');
  await mustFail(prove([Buffer.alloc(64, 0xab)], 0), 'merkle');
});

test('R2-C codeSwap precommit is rejected', async () => {
  const owner = key();
  const u = fresh(owner);
  const desc = [{ satoshis: u.satoshis, state: { ...u.state, n: u.state.n - 1, phase: 0, intent: ZERO }, codeSwap: true }];
  const announced = await mustOk(spendAnnounce(u, { key: owner, lockTime: 0, intent: hashOutputs(desc) }));
  const utxo = announced.outputs[0];
  const chain = fakeChain(internalTxid(utxo.txid));
  await mustFail(spendConfirmUse(utxo, {
    key: owner, lockTime: 0, headers: chain.headers, tamper: () => desc,
  }), 'hashOutputs');
});

test('R2-C burn output cannot take the satoshis', async () => {
  const owner = key();
  const u = fresh(owner);
  const desc = [
    { satoshis: 0, state: { ...u.state, n: u.state.n - 1, phase: 0, intent: ZERO } },
    { satoshis: u.satoshis, burn: 0 },
  ];
  const announced = await mustOk(spendAnnounce(u, { key: owner, lockTime: 0, intent: hashOutputs(desc) }));
  const utxo = announced.outputs[0];
  const chain = fakeChain(internalTxid(utxo.txid));
  await mustFail(spendConfirmUse(utxo, {
    key: owner, lockTime: 0, headers: chain.headers, tamper: () => desc,
  }), 'hashOutputs');
});

test('R2-C honest intent rejects reorder, skim, and switched path', async () => {
  const owner = key();
  const u = fresh(owner);
  const children = [child(key(), 2, 400), child(key(), 1, 600)];
  const announced = await mustOk(spendAnnounceDelegate(u, { key: owner, lockTime: 0, children }));
  const utxo = announced.outputs[0];
  const noHeaders = { key: owner, lockTime: 0, children };
  await mustFail(spendConfirmDelegate(utxo, { ...noHeaders, tamper: (o) => [o[1], o[0], o[2]] }), 'confirm:intent');
  await mustFail(spendConfirmDelegate(utxo, { ...noHeaders, tamper: (o) => [{ ...o[0], satoshis: 1 }, o[1], o[2]] }), 'confirm:intent');
  await mustFail(spendConfirmDelegate(utxo, { ...noHeaders, tamper: (o) => [o[0], o[1]] }), 'confirm:intent');
  await mustFail(spendConfirmUse(utxo, { key: owner, lockTime: 0 }), 'confirm:intent');
});

function delegateDescs(utxo, children) {
  const s = utxo.state;
  const R2 = deriveR(s.R, s.holder);
  const mk = (c) => ({
    satoshis: c.v,
    state: { holder: c.holder, R: R2, n: Math.max(0, c.n), P: c.P, T: c.T, phase: 0, intent: ZERO, d: s.d + 1 },
  });
  return [mk(children[0]), mk(children[1]), { satoshis: 0, burn: Math.max(0, s.n - children[0].n - children[1].n) }];
}

test('R2-C delegate reorder precommit is rejected', async () => {
  const owner = key();
  const u = fresh(owner);
  const children = [child(key(), 2, 400), child(key(), 1, 600)];
  const honestDescs = delegateDescs(u, children);
  assert.equal(hashOutputs(honestDescs), intentHash(u, { children }, PATH.DELEGATE));
  const announced = await mustOk(spendAnnounceDelegate(u, { key: owner, lockTime: 0, children }));
  const utxo = announced.outputs[0];
  const chain = fakeChain(internalTxid(utxo.txid));
  await mustFail(spendConfirmDelegate(utxo, {
    key: owner, lockTime: 0, children, headers: chain.headers,
    tamper: (o) => [o[1], o[0], o[2]],
  }), 'confirm:intent');

  const swapped = [honestDescs[1], honestDescs[0], honestDescs[2]];
  const u2 = fresh(owner);
  const pre = await mustOk(spendAnnounce(u2, { key: owner, lockTime: 0, intent: hashOutputs(swapped) }));
  const chain2 = fakeChain(internalTxid(pre.outputs[0].txid));
  await mustFail(spendConfirmDelegate(pre.outputs[0], {
    key: owner, lockTime: 0, children, headers: chain2.headers,
    tamper: () => swapped,
  }), 'hashOutputs');
});

test('R2-D reannounce, cancel, and quota inflation fail; ancestor still reclaims', async () => {
  const { owner, parent, utxo } = await attackFixture();
  await mustFail(spendAnnounceUse(utxo, { key: owner, lockTime: 0 }), 'announce:phase');
  await mustFail(spendReclaim(utxo, { key: owner, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 }), 'reclaim:chain=R');
  const back = await mustOk(spendReclaim(utxo, {
    key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0, sequence: 0xffffffff,
  }));
  assert.equal(back.outputs[0].state.n, 3);
  assert.equal(back.outputs[0].state.phase, 0);

  const issuer = key();
  const root = fresh(issuer);
  const stuck = await mustOk(spendAnnounce(root, { key: issuer, lockTime: 0, intent: 'ab'.repeat(32) }));
  assert.equal(stuck.outputs[0].state.n, 3);
  await mustFail(spendConfirmUse(stuck.outputs[0], { key: issuer, lockTime: 0 }), 'confirm:intent');
  await mustFail(spendReclaim(stuck.outputs[0], { key: issuer, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 }), 'reclaim:k<=d');

  const kids = [child(key(), 0x7fffffff), child(key(), 0x7fffffff)];
  const inflated = await mustOk(spendAnnounceDelegate(root, { key: issuer, lockTime: 0, children: kids }));
  const chain = fakeChain(internalTxid(inflated.outputs[0].txid));
  await mustFail(spendConfirmDelegate(inflated.outputs[0], {
    key: issuer, lockTime: 0, children: kids, headers: chain.headers,
  }), 'delegate:sum<=n');
});

test('R2-E mainnet-target announcement rejects easy confirmation while ancestor reclaims', async () => {
  const { owner, parent, utxo, chain } = await attackFixture(true);
  await mustFail(spendConfirmUse(utxo, { key: owner, lockTime: 0, headers: chain.headers }), 'headers:work');
  const back = await mustOk(spendReclaim(utxo, {
    key: parent, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0, sequence: 0xffffffff,
  }));
  assert.equal(back.outputs[0].state.n, 3);
  assert.equal(back.outputs[0].state.phase, 0);
  assert.equal(back.outputs[0].params.target, MAINNET_TARGET);
});

test('R2-F low-S lockTime does not free the header bind or the expiry', async () => {
  const { owner, utxo, chain, announced } = await attackFixture();
  assert.ok(announced.lockTime >= 0 && announced.lockTime < 400);
  const atThreshold = await mustOk(spendConfirmUse(utxo, {
    key: owner, lockTime: 500_000_000, headers: chain.headers,
  }));
  assert.ok(atThreshold.lockTime >= 500_000_000);
  assert.ok(atThreshold.lockTime < 500_000_000 + 400);
  const wrongLeaf = fakeChain('ab'.repeat(32));
  await mustFail(spendConfirmUse(utxo, { key: owner, lockTime: 0, headers: wrongLeaf.headers }), 'merkle');
});
