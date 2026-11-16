// 取引の組み立てとローカル評価。送信・ブロードキャストは一切しない（@bsv/sdk の Spend.validate のみ）。
import { createHash, randomBytes } from 'node:crypto';
import { Spend, Transaction, TransactionSignature, UnlockingScript, LockingScript, Hash } from '@bsv/sdk';
import { COV, covParams, argCount, compactSize, PATH, covLockingScript, u32le, ruleAt } from './script.mjs';
import { chainHeaders } from './headers.mjs';
import { numTok } from './asm.mjs';

export { COV, ROOT_R } from './script.mjs';

/** 標準的な Genesis 後ポリシー（低S・厳密DER・最小push・クリーンスタック）で評価する。 */
export const VERIFY_FLAGS = 'UTXO_AFTER_GENESIS,LOW_S,STRICTENC,SIGHASH_FORKID,DERSIG,MINIMALDATA,NULLDUMMY,CLEANSTACK,SIGPUSHONLY';
const SCOPE = 0x41;
const N_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GRIND_LIMIT = 400;

const sha256 = (buf) => createHash('sha256').update(buf).digest();
/** R_k = H(R_{k-1} ‖ pk_k） */
export function deriveR(Rhex, pkHex) {
  return sha256(Buffer.concat([Buffer.from(Rhex, 'hex'), Buffer.from(pkHex, 'hex')])).toString('hex');
}

export function makeUtxo({ state, satoshis = 1000, txid, vout = 0, params }) {
  params = covParams(params);
  return { params, txid: txid ?? randomBytes(32).toString('hex'), vout, satoshis, state: { ...state }, script: covLockingScript(state, params) };
}

const hexPush = (hex) => (hex === '' ? 'OP_0' : hex);
const pubHex = (key) => key.toPublicKey().toString();

/** 出力記述子 → LockingScript。codeSwap は「コード部だけ別物」の改ざん表現。 */
function scriptOf(o) {
  if (o.burn !== undefined) return LockingScript.fromHex(`006a04${u32le(o.burn)}`);
  if (o.codeSwap) return LockingScript.fromASM(`${covLockingScript(o.state, o.params).toASM().split(' ')[0]} OP_DROP OP_1`);
  return covLockingScript(o.state, o.params);
}

function honestOutputs(path, utxo, spec) {
  const s = utxo.state;
  if (path === PATH.ANNOUNCE) return [{ satoshis: utxo.satoshis, state: { ...s, phase: 1, intent: spec.intent } }];
  if (path === PATH.USE) {
    return [{ satoshis: utxo.satoshis, state: { ...s, n: Math.max(0, s.n - (spec.k ?? 1)), phase: 0, intent: '00'.repeat(32) } }];
  }
  if (path === PATH.DELEGATE) {
    const R2 = deriveR(s.R, s.holder);
    const [a, b] = spec.children;
    const mk = (c) => ({
      satoshis: c.v,
      state: { holder: c.holder, R: R2, n: Math.max(0, c.n), P: c.P, T: c.T, phase: 0, intent: '00'.repeat(32), d: s.d + 1 },
    });
    return [mk(a), mk(b), { satoshis: 0, burn: Math.max(0, s.n - a.n - b.n) }];
  }
  return [
    { satoshis: utxo.satoshis, state: { holder: pubHex(spec.key), R: spec.Rprev, n: s.n, P: s.P, T: s.T, phase: 0, intent: '00'.repeat(32), d: spec.k - 1 } },
  ];
}

function argTokens(path, spec, sigHex, params) {
  const pad = (a) => [...a, ...Array(argCount(params) - a.length).fill('OP_0')];
  const proof = [
    ...Array.from({ length: params.K + 1 }, (_, i) => hexPush(spec.headers?.[i]?.toString('hex') ?? '')),
    numTok(spec.merkleProof?.index ?? 0),
    ...Array.from({ length: COV.MERKLE_MAX }, (_, i) => hexPush(spec.merkleProof?.siblings?.[i]?.toString('hex') ?? '')),
  ];
  const confirmed = (args) => [...args, ...Array(11 - args.length).fill('OP_0'), ...proof];
  if (path === PATH.ANNOUNCE) return pad([sigHex, spec.intent]);
  if (path === PATH.USE) return confirmed([sigHex, numTok(spec.k ?? 1)]);
  if (path === PATH.DELEGATE) {
    const [a, b] = spec.children;
    return confirmed([
      sigHex,
      numTok(a.n), a.holder, u32le(a.P), numTok(a.T), numTok(a.v),
      numTok(b.n), b.holder, u32le(b.P), numTok(b.T),
    ]);
  }
  const slots = Array.from({ length: COV.DMAX - 1 }, (_, i) => hexPush(spec.chain[i] ?? ''));
  return pad([sigHex, pubHex(spec.key), spec.Rprev, numTok(spec.k), ...slots]);
}

/** sha256d(preimage) から OP_PUSH_TX の署名 s を作ったとき、低S かつ DER が最小長（32バイト）か。 */
function pushTxSigUsable(preimage) {
  const z = BigInt('0x' + sha256(sha256(preimage)).toString('hex'));
  const s = (z + GX) % N_ORDER;
  return s <= N_ORDER / 2n && s >> 248n !== 0n;
}

function signPreimage(key, preimage, scope = SCOPE) {
  const raw = key.sign(Array.from(sha256(preimage)));
  return Buffer.from(new TransactionSignature(raw.r, raw.s, scope).toChecksigFormat()).toString('hex');
}

async function run(path, utxo, spec) {
  const sequence = spec.sequence ?? 0xfffffffe;
  const sigKey = spec.signWith ?? spec.key;
  for (let L = spec.lockTime, tries = 0; tries < GRIND_LIMIT; L++, tries++) {
    let descs = honestOutputs(path, utxo, spec).map(o => o.state ? { ...o, params: utxo.params } : o);
    if (spec.tamper) descs = spec.tamper(descs);
    const outputs = descs.map((o) => ({ satoshis: o.satoshis, lockingScript: scriptOf(o) }));
    const base = {
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.vout,
      sourceSatoshis: utxo.satoshis,
      transactionVersion: 1,
      otherInputs: spec.extraInput ? [{ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff }] : [],
      outputs,
      inputIndex: 0,
      inputSequence: sequence,
      lockTime: L,
    };
    const real = Buffer.from(TransactionSignature.format({ ...base, subscript: utxo.script, scope: SCOPE }));
    if (!pushTxSigUsable(real)) continue; // nLockTime を 1 動かして再試行（規則の許容範囲内）
    const preimage = spec.mutatePreimage ? Buffer.from(spec.mutatePreimage(real)) : real;
    const unlockingScript = UnlockingScript.fromASM(
      [...argTokens(path, spec, signPreimage(sigKey, real, spec.sigScope), utxo.params), preimage.toString('hex'), numTok(path)].join(' ')
    );
    const spend = new Spend({ ...base, lockingScript: utxo.script, unlockingScript, verifyFlags: VERIFY_FLAGS });
    let ok = false;
    let error;
    let failedRule;
    const validationStart = performance.now();
    try {
      ok = spend.validate();
      if (!ok) error = 'script evaluated to false';
    } catch (e) {
      error = e.message;
      const pc = /PC: (\d+)/.exec(error);
      if (pc && /LockingScript/.test(error)) failedRule = ruleAt(Number(pc[1]), utxo.params);
    }
    const result = { validateMs: performance.now() - validationStart, ok, error, failedRule, lockTime: L, scriptSize: utxo.script.toBinary().length, unlockSize: unlockingScript.toBinary().length };
    if (!ok) return result;
    const tx = new Transaction(1, [{ sourceTXID: utxo.txid, sourceOutputIndex: utxo.vout, unlockingScript, sequence }], outputs, L);
    const txid = tx.id('hex');
    const authOuts = [];
    descs.forEach((o, i) => {
      if (o.state) authOuts.push({ params: o.params, txid, vout: i, satoshis: o.satoshis, state: o.state, script: outputs[i].lockingScript });
    });
    const burn = descs.find((o) => o.burn !== undefined);
    return { ...result, transaction: tx, outputs: authOuts, burned: burn?.burn ?? 0 };
  }
  return { ok: false, error: 'no usable nLockTime within grind limit' };
}

const guard = (path) => async (utxo, spec) => {
  try {
    return await run(path, utxo, spec);
  } catch (e) {
    return { ok: false, error: `builder: ${e.message}` };
  }
};

export const spendUse = guard(PATH.USE);
export const spendDelegate = guard(PATH.DELEGATE);
export const spendReclaim = guard(PATH.RECLAIM);

// Commitment to exactly the confirmed serialized outputs, including satoshis and code.
export function intentHash(utxo, spec, kind = PATH.USE) {
  const bytes = honestOutputs(kind, utxo, spec).map((o) => {
    const sc = Buffer.from(scriptOf({ ...o, params: utxo.params }).toBinary());
    const value = Buffer.alloc(8); value.writeBigUInt64LE(BigInt(o.satoshis));
    const len = compactSize(sc.length);
    // Burn outputs are seven bytes, hence their CompactSize is a single byte.
    return Buffer.concat([value, len, sc]);
  });
  return sha256(sha256(Buffer.concat(bytes))).toString('hex');
}
export const spendAnnounce = guard(PATH.ANNOUNCE);
export const spendAnnounceUse = (utxo, spec) => spendAnnounce(utxo, { ...spec, intent: spec.intent ?? intentHash(utxo, spec) });
export const spendAnnounceDelegate = (utxo, spec) => spendAnnounce(utxo, { ...spec, intent: spec.intent ?? intentHash(utxo, spec, PATH.DELEGATE) });
export const spendConfirmUse = spendUse;
export const spendConfirmDelegate = spendDelegate;
// Test convenience only: both transactions are independently validated by Spend.validate.
export async function announceAndConfirm(utxo, spec, kind = PATH.USE) {
  const announced = await spendAnnounce(utxo, { ...spec, tamper: undefined, intent: intentHash(utxo, spec, kind) });
  if (!announced.ok) return announced;
  const pending = announced.outputs[0];
  const headers = chainHeaders(pending.params.K + 1, Buffer.from(pending.txid, 'hex').reverse().toString('hex'), 1_700_000_000, pending.params.target);
  return guard(kind)(pending, { ...spec, headers });
}
