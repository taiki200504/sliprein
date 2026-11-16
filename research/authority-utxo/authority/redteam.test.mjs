// Adversarial transactions evaluated exclusively by @bsv/sdk Spend.validate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { PrivateKey, Spend, TransactionSignature, UnlockingScript, LockingScript } from '@bsv/sdk';
import { COV, ROOT_R, makeUtxo, covLockingScript, spendAnnounceUse, spendAnnounceDelegate,
  spendConfirmUse, spendConfirmDelegate, spendReclaim, VERIFY_FLAGS, intentHash } from './lib/cov/index.mjs';
import { ARGS, PATH, codeAsmCached, ruleAt, u32le, encodeState } from './lib/cov/script.mjs';
import { numTok } from './lib/cov/asm.mjs';
import { chainHeaders, mineHeader, sha256d, assembleHeader, headerHashLE, TEST_TARGET } from './lib/cov/headers.mjs';
const SCOPE = 0x41, GRIND_LIMIT = 400;
const N_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const sha256 = (b) => createHash('sha256').update(b).digest();
const pk = (k) => k.toPublicKey().toString();
const key = () => PrivateKey.fromRandom();
const T = 2_000_000_000;
const child = (k, n, P = 1) => ({ holder: pk(k), n, P, T, v: 500 });
const fresh = (owner, patch = {}) => makeUtxo({state: {holder: pk(owner), R: ROOT_R, n: 3, P: 1, T, d: 0, ...patch}});
const show = (r) => JSON.stringify({ok:r.ok, rule:r.failedRule, error:r.error?.slice(0,100)});
async function mustOk(p) {const r=await p; assert.equal(r.ok,true,show(r)); return r;}
async function mustFail(p, rule) {const r=await p; assert.equal(r.ok,false,show(r));
  assert.ok(!r.error?.startsWith('builder:'),show(r));
  if(rule) assert.equal(r.failedRule,rule,show(r)); return r;}
async function pending(patch = {}) {
  const owner = key(), root = fresh(owner, patch);
  const r = await mustOk(spendAnnounceUse(root, {key:owner,lockTime:0}));
  const utxo = r.outputs[0];
  const headers = chainHeaders(COV.K+1, Buffer.from(utxo.txid,'hex').reverse().toString('hex'));
  return {owner,root,utxo,headers};
}
function pushTxSigUsable(preimage) {
  const z = BigInt('0x' + sha256(sha256(preimage)).toString('hex'));
  const s = (z + GX) % N_ORDER;
  return s <= N_ORDER / 2n && s >> 248n !== 0n;
}
function signPreimage(priv, preimage, scope) {
  const raw = priv.sign(Array.from(sha256(preimage)));
  return Buffer.from(new TransactionSignature(raw.r, raw.s, scope).toChecksigFormat()).toString('hex');
}

/** spend.mjs を通さない生の消費。高位ビットの状態と、数値トークンの差し替えに使う。 */
async function evalPath(spec) {
  const sequence = spec.sequence ?? 0xfffffffe;
  const scope = spec.sigScope ?? SCOPE;
  for (let L = spec.lockTime, tries = 0; tries < GRIND_LIMIT; L++, tries++) {
    const descs = spec.outputsFor(L);
    const outputs = descs.map((o) => ({
      satoshis: o.satoshis,
      lockingScript: o.lockingScript ?? (o.burn !== undefined ? LockingScript.fromHex(`006a04${u32le(o.burn)}`) : covLockingScript(o.state)),
    }));
    const base = {
      sourceTXID: spec.txid,
      sourceOutputIndex: spec.vout ?? 0,
      sourceSatoshis: spec.satoshis,
      transactionVersion: 1,
      otherInputs: spec.extraInput ? [{ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff }] : [],
      outputs,
      inputIndex: 0,
      inputSequence: sequence,
      lockTime: L,
    };
    const real = Buffer.from(TransactionSignature.format({ ...base, subscript: spec.script, scope: SCOPE }));
    if (!pushTxSigUsable(real)) continue;
    const given = spec.args(signPreimage(spec.key, real, scope));
    const padded = [...given, ...Array(Math.max(0, ARGS - given.length)).fill('OP_0')];
    const unlockingScript = UnlockingScript.fromASM([...padded, real.toString('hex'), numTok(spec.path)].join(' '));
    const spend = new Spend({ ...base, lockingScript: spec.script, unlockingScript, verifyFlags: VERIFY_FLAGS });
    let ok = false;
    let error;
    let failedRule;
    try {
      ok = spend.validate();
      if (!ok) error = 'script evaluated to false';
    } catch (e) {
      error = e.message;
      const pc = /PC: (\d+)/.exec(error);
      if (pc && /LockingScript/.test(error)) failedRule = ruleAt(Number(pc[1]));
    }
    const result = { ok, error, failedRule, lockTime: L, outputs: descs };
    if (!ok) return result;
    return result;
  }
  return { ok: false, error: 'no usable nLockTime within grind limit' };
}


for (const [id, lockTime] of [['X01',1_600_000_000],['X02',0],['X03',500_000_000],['X04',1_000_000],['X05',1_900_000_000]]) {
  test(`${id} nLockTime alone cannot directly spend idle authority`, async () => {
    const owner=key(); await mustFail(spendConfirmUse(fresh(owner), {key:owner,lockTime}), 'confirm:phase');
  });
}
// Exercise raw locking bytes: builder-side encodeState checks cannot substitute for Script checks.
for (const [id, field] of [['X06','n'],['X22','d'],['N01','P'],['N02','T']]) {
  for (const value of [0x80000000,0x80000001,0xffffffff]) {
    test(`${id} raw ${field}=${value} rejected by Script`,async()=>{
      const owner=key(), u=fresh(owner);
      const bytes=Buffer.from(encodeState(u.state),'hex');
      bytes.writeUInt32LE(value,{n:65,P:69,T:73,d:77}[field]);
      const script=LockingScript.fromASM(`${bytes.toString('hex')} OP_DROP ${codeAsmCached()}`);
      await mustFail(evalPath({script,txid:u.txid,satoshis:1000,key:owner,lockTime:0,path:PATH.ANNOUNCE,
        args:(sig)=>[sig,'11'.repeat(32)],outputsFor:()=>[{satoshis:1000,state:u.state}]}),`range:${field}`);
    });
  }
}
test('X07 pending holder cannot confirm without work; ancestor immediately reclaims',async()=>{
  const owner=key(), parent=key();
  const R=sha256(Buffer.concat([Buffer.alloc(32),Buffer.from(pk(parent),'hex')])).toString('hex');
  const root=fresh(owner,{R,d:1});
  const a=await mustOk(spendAnnounceUse(root,{key:owner,lockTime:0}));
  await mustFail(spendConfirmUse(a.outputs[0],{key:owner,lockTime:0}),'headers:size');
  const back=await mustOk(spendReclaim(a.outputs[0],{key:parent,k:1,Rprev:ROOT_R,chain:[],lockTime:0,sequence:0xffffffff}));
  assert.equal(back.outputs[0].state.n,3); assert.equal(back.outputs[0].state.phase,0);
});
test('H01 K headers instead of h0..hK rejected',async()=>{
  const {owner,utxo,headers}=await pending();
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers:headers.slice(0,COV.K)}),'headers:size');
});
test('H02 broken prevhash rejected even with valid work',async()=>{
  const {owner,utxo,headers}=await pending();
  headers[2]=mineHeader({prevHex:'00'.repeat(32),merkleHex:'11'.repeat(32),time:1700001200}).header;
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers}),'headers:link');
});
test('H03 insufficient work rejected',async()=>{
  const {owner,utxo,headers}=await pending();
  const h=Buffer.from(headers[0]);
  for(let nonce=0;;nonce++) {h.writeUInt32LE(nonce,76);if(headerHashLE(h)>TEST_TARGET)break;}
  headers[0]=h;
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers}),'headers:work');
});
test('H04 proof for a different txid rejected',async()=>{
  const {owner,utxo}=await pending();const headers=chainHeaders(COV.K+1,'ab'.repeat(32));
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers}),'merkle');
});
test('H05 changed intent/output rejected',async()=>{
  const {owner,utxo,headers}=await pending();
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers,tamper:o=>[{...o[0],state:{...o[0].state,n:3}}]}),'confirm:intent');
});
test('H06 hK.time after T rejected despite old lockTime',async()=>{
  const {owner,utxo}=await pending({T:1600000000});
  const headers=chainHeaders(3,Buffer.from(utxo.txid,'hex').reverse().toString('hex'),1700000000);
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers}),'headers:expiry');
});
test('H07 valid headers cannot authorize idle direct use',async()=>{
  const {owner,root,headers}=await pending();
  await mustFail(spendConfirmUse(root,{key:owner,lockTime:0,headers}),'confirm:phase');
});
test('H08 valid two-leaf Merkle proof and reversed direction rejected',async()=>{
  const {owner,utxo}=await pending();
  const txid=Buffer.from(utxo.txid,'hex').reverse(), sibling=Buffer.from('ab'.repeat(32),'hex');
  const root=sha256d(Buffer.concat([sibling,txid]));
  const headers=chainHeaders(3,root.toString('hex'));
  await mustOk(spendConfirmUse(utxo,{key:owner,lockTime:0,headers,merkleProof:{siblings:[sibling],index:1}}));
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers,merkleProof:{siblings:[sibling],index:0}}),'merkle');
});
test('H09 nonzero unused Merkle index rejected',async()=>{
  const {owner,utxo,headers}=await pending();
  await mustFail(spendConfirmUse(utxo,{key:owner,lockTime:0,headers,merkleProof:{siblings:[],index:1}}),'merkle');
});
test('H10 pending announcement cannot be replaced by a new announcement',async()=>{
  const {owner,utxo}=await pending();
  await mustFail(spendAnnounceUse(utxo,{key:owner,lockTime:0}),'announce:phase');
});
test('H11 announce preserves n/P/T/R and forbids extra outputs',async()=>{
  const owner=key(), u=fresh(owner);
  for(const patch of [{n:4},{P:3},{T:T+1},{R:'ff'.repeat(32)}])
    await mustFail(spendAnnounceUse(u,{key:owner,lockTime:0,tamper:o=>[{...o[0],state:{...o[0].state,...patch}}]}),'hashOutputs');
});
test('H12 delegate confirmation also requires proof and exact intent',async()=>{
  const owner=key(), u=fresh(owner);const children=[child(key(),2),child(key(),1)];
  const a=await mustOk(spendAnnounceDelegate(u,{key:owner,lockTime:0,children}));const utxo=a.outputs[0];
  await mustFail(spendConfirmDelegate(utxo,{key:owner,lockTime:0,children}),'headers:size');
  const headers=chainHeaders(3,Buffer.from(utxo.txid,'hex').reverse().toString('hex'));
  await mustOk(spendConfirmDelegate(utxo,{key:owner,lockTime:0,children,headers}));
  await mustFail(spendConfirmDelegate(utxo,{key:owner,lockTime:0,children:[{...children[0],n:3},children[1]],headers}),'confirm:intent');
});
