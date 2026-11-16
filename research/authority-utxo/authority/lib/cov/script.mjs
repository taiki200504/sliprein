// OP_PUSH_TX 型コベナント: 規則そのものをロックスクリプトに書く。
//
// ロックスクリプト = <state114 を PUSHDATA1 で push> OP_DROP <CODE>。
// 状態の読み取りは、検証済み sighash preimage（scriptCode に状態が入っている）から行う。
// 出力は「自分の scriptCode の push 部だけ差し替えた同一コード」で組み、hashOutputs と一致を強制する。
import { LockingScript } from '@bsv/sdk';
import { Asm, numTok } from './asm.mjs';

export const COV = Object.freeze({
  /** 予告を含む h0 の後に必要なヘッダ数。既定のテスト用値。 */
  K: 2,
  MERKLE_MAX: 8,
  /** 委任の深さ上限。奪還の開示長が有限で、スクリプトを展開できる範囲。 */
  DMAX: 8,
});
export const ROOT_R = '00'.repeat(32);

export const STATE_LEN = 114; // holder33 | R32 | n4 | P4 | T4 | d4 | phase1 | intent32
const PUSH_HDR = '4c72'; // OP_PUSHDATA1 0x72
const HDR_LEN = 2 + STATE_LEN;

const GX = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const G_PUBKEY = `02${GX}`;
const N_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const le = (hexBE) => Buffer.from(hexBE, 'hex').reverse().toString('hex');
const GX_NUM = le(GX); // 先頭ビットが 0 なので符号パディング不要
const N_NUM = le(N_ORDER.toString(16)) + '00';

export function u32le(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(v));
  return b.toString('hex');
}

/** 状態を 114 バイトの hex にする。 */
export function encodeState(s) {
  const holder = Buffer.from(s.holder, 'hex');
  const R = Buffer.from(s.R, 'hex');
  if (holder.length !== 33) throw new Error('holder must be 33-byte compressed pubkey');
  if (R.length !== 32) throw new Error('R must be 32 bytes');
  for (const k of ['n', 'P', 'T', 'd']) {
    if (!Number.isSafeInteger(s[k]) || s[k] < 0 || s[k] > 0x7fffffff) throw new Error(`state.${k} out of range`);
  }
  const phase = s.phase ?? 0;
  const intent = s.intent ?? '00'.repeat(32);
  if (![0, 1].includes(phase) || !/^[0-9a-f]{64}$/.test(intent)) throw new Error('invalid phase/intent');
  return holder.toString('hex') + R.toString('hex') + u32le(s.n) + u32le(s.P) + u32le(s.T) + u32le(s.d) + Buffer.from([phase]).toString('hex') + intent;
}

function reverse32(a) {
  // [x] → [reverse(x)]（32 バイト固定）。BSV の Script には OP_REVERSE が無いので 1 バイトずつ前置する。
  a.raw('OP_0', 0, ['_acc']);
  for (let i = 0; i < 32; i++) {
    a.tokens.push('OP_SWAP', 'OP_1', 'OP_SPLIT', 'OP_ROT', 'OP_ROT', 'OP_SWAP', 'OP_CAT');
  }
  a.tokens.push('OP_NIP');
  a.st.pop();
  a.st.pop();
  a.st.push('_rev');
}

/**
 * OP_PUSH_TX: preimage の sha256d を z とし、k=1・d=1 の署名 (r=Gx, s=z+Gx mod n) を組んで
 * 公開鍵 G で OP_CHECKSIG する。通るのは「渡された preimage が本物の sighash と一致する」ときだけ。
 * 低S・DER 最小長は呼び出し側が nLockTime を動かして満たす（spend.mjs）。
 */
function pushTx(a) {
  a.mark('pushtx');
  a.pick('preimage', '_p');
  a.top('OP_HASH256', '_z');
  reverse32(a);
  a.top(['00', 'OP_CAT', 'OP_BIN2NUM', GX_NUM, 'OP_ADD', N_NUM, 'OP_MOD', '20', 'OP_NUM2BIN'], '_s');
  reverse32(a);
  a.top([`3044022079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817980220`, 'OP_SWAP', 'OP_CAT', '41', 'OP_CAT'], '_sig');
  a.pushHex(G_PUBKEY, '_pk');
  a.raw('OP_CHECKSIGVERIFY', 2, []);
}

/** 署名型が 0x41（ALL|FORKID）であることを強制し、pk で検証する（出力全体を署名に縛る）。 */
function sigCheck(a, sig, pk) {
  a.mark(`sig:${sig}`);
  a.pick(sig, '_sg');
  a.raw(['OP_DUP', 'OP_SIZE', 'OP_1SUB', 'OP_SPLIT', 'OP_NIP', '41', 'OP_EQUALVERIFY'], 1, ['_sg']);
  a.pick(pk, '_pk');
  a.raw('OP_CHECKSIGVERIFY', 2, []);
}

const cat = (n) => Array(n - 1).fill('OP_CAT').join(' ');
const SIZE_IS = (hexLen) => `OP_SIZE OP_NIP ${hexLen} OP_NUMEQUALVERIFY`;

/** value ‖ varint ‖ push ヘッダ ‖ 状態 ‖ 自分と同一のコード を連結して積む。 */
function authOut(a, valueName, stateName, as) {
  a.calc([valueName, 'vint', { h: PUSH_HDR }, stateName, 'tail'], cat(5), as);
}

const ZERO_INTENT = '00'.repeat(32);
const IDLE = '00';
// Defaults preserve the easy local-test issuance profile.
export const DEFAULT_PARAMS = Object.freeze({ K: 2, target: (1n << 240n) - 1n });
export function covParams(params = DEFAULT_PARAMS) {
  const { K, target } = params;
  if (!Number.isInteger(K) || K < 1 || K > 512) throw new Error('K must be 1..512');
  if (typeof target !== 'bigint' || target < 1n || target >= (1n << 256n)) throw new Error('target must be unsigned 256-bit positive bigint');
  return Object.freeze({ K, target });
}
export const argCount = (params = DEFAULT_PARAMS) => 11 + params.K + 1 + 1 + COV.MERKLE_MAX;
export function compactSize(length) {
  if (length < 253) return Buffer.from([length]);
  const b = Buffer.alloc(length <= 65535 ? 3 : 5);
  b[0] = b.length === 3 ? 0xfd : 0xfe;
  if (b.length === 3) b.writeUInt16LE(length, 1); else b.writeUInt32LE(length, 1);
  return b;
}

function bounded(a, name, bytes = false, label = `range:${name}`) {
  a.mark(label);
  if (bytes) {
    a.calc([name], 'OP_BIN2NUM', `${name}N`);
    // Round-trip rejects signed negative zero as well as a set sign bit.
    a.calc([`${name}N`], 'OP_4 OP_NUM2BIN', '_canonical');
    a.calc([name, '_canonical'], 'OP_EQUALVERIFY', null);
  }
  const nm = bytes ? `${name}N` : name;
  a.calc([nm, { n: 0 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
  a.calc([nm, { n: 0x7fffffff }], 'OP_LESSTHANOREQUAL OP_VERIFY', null);
}

function confirmGate(a, params) {
  const targetLE = le(params.target.toString(16).padStart(64, '0')) + '00';
  sigCheck(a, 'sig', 'holder');
  a.mark('confirm:phase');
  a.calc(['phase', { n: 1 }], 'OP_EQUALVERIFY', null);
  a.calc(['T'], 'OP_BIN2NUM', 'TN');
  a.mark('confirm:intent');
  a.calc(['hOut', 'intent'], 'OP_EQUALVERIFY', null);
  for (let i = 0; i <= params.K; i++) {
    const h = `header${i}`;
    a.mark('headers:size');
    a.calc([h], SIZE_IS('50'), null);
    a.calc([h], 'OP_HASH256', `hh${i}`);
    a.mark('headers:work');
    a.calc([`hh${i}`], '00 OP_CAT OP_BIN2NUM', '_work');
    a.calc(['_work', { h: targetLE }], 'OP_BIN2NUM OP_LESSTHANOREQUAL OP_VERIFY', null);
    if (i > 0) {
      a.mark('headers:link');
      a.calc([h], 'OP_4 OP_SPLIT OP_NIP 20 OP_SPLIT OP_DROP', '_prev');
      a.calc(['_prev', `hh${i - 1}`], 'OP_EQUALVERIFY', null);
    }
  }
  a.mark('headers:expiry');
  a.calc([`header${params.K}`], '44 OP_SPLIT OP_NIP OP_4 OP_SPLIT OP_DROP 00 OP_CAT OP_BIN2NUM', '_time');
  a.calc(['_time', 'TN'], 'OP_LESSTHANOREQUAL OP_VERIFY', null);
  a.mark('merkle');
  a.calc(['outpoint'], '20 OP_SPLIT OP_DROP', 'leaf');
  a.calc(['merkleIndex', { n: 0 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
  a.pick('merkleIndex', 'mi');
  for (let i = 0; i < COV.MERKLE_MAX; i++) {
    const sib = `merkle${i}`;
    a.calc([sib], 'OP_SIZE OP_NIP OP_0 OP_GREATERTHAN', '_present');
    a.ifelse((b) => {
      b.calc([sib], SIZE_IS('20'), null);
      b.calc(['mi', { n: 2 }], 'OP_MOD', '_right');
      b.ifelse((c) => c.calc([sib, 'leaf'], 'OP_CAT OP_HASH256', '_leaf'),
        (c) => c.calc(['leaf', sib], 'OP_CAT OP_HASH256', '_leaf'));
      b.drop('leaf'); b.roll('_leaf', 'leaf');
      b.calc(['mi', { n: 2 }], 'OP_DIV', '_mi'); b.drop('mi'); b.roll('_mi', 'mi');
    }, (b) => { b.roll('leaf'); b.roll('mi'); });
  }
  a.calc(['mi', { n: 0 }], 'OP_NUMEQUALVERIFY', null);
  a.calc(['header0'], '24 OP_SPLIT OP_NIP 20 OP_SPLIT OP_DROP', '_root');
  a.calc(['leaf', '_root'], 'OP_EQUALVERIFY', null);
}

function announcePath(a) {
  a.st[0] = 'sig'; a.st[1] = 'newIntent';
  sigCheck(a, 'sig', 'holder');
  a.mark('announce:phase');
  a.calc(['phase', { h: IDLE }], 'OP_EQUALVERIFY', null);
  a.mark('announce:intent-size');
  a.calc(['newIntent'], SIZE_IS('20'), null);
  a.calc(['holder', 'R', 'n', 'P', 'T', 'd', { n: 1 }, 'newIntent'], cat(8), 'st2');
  authOut(a, 'value', 'st2', 'out');
  verifyOutputs(a, 'out'); a.finish();
}

function verifyOutputs(a, outName) {
  a.mark('hashOutputs');
  a.calc([outName], 'OP_HASH256', '_h');
  a.calc(['hOut', '_h'], 'OP_EQUALVERIFY', null);
}

function usePath(a, params) {
  a.st[0] = 'sig'; a.st[1] = 'useK';
  confirmGate(a, params);
  a.calc(['n'], 'OP_BIN2NUM', 'nN');
  a.mark('use:n>=1');
  a.calc(['nN', { n: 1 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
  a.mark('use:k>=1');
  a.calc(['useK', { n: 1 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
  a.mark('use:k<=n');
  a.calc(['useK', 'nN'], 'OP_LESSTHANOREQUAL OP_VERIFY', null);
  a.calc(['nN', 'useK'], 'OP_SUB OP_4 OP_NUM2BIN', 'n2');
  a.calc(['holder', 'R', 'n2', 'P', 'T', 'd', { h: IDLE }, { h: ZERO_INTENT }], cat(8), 'st2');
  authOut(a, 'value', 'st2', 'out');
  verifyOutputs(a, 'out');
  a.finish();
}

function delegatePath(a, params) {
  ['sig', 'nA', 'pkA', 'PA', 'TA', 'vA', 'nB', 'pkB', 'PB', 'TB'].forEach((nm, i) => (a.st[i] = nm));
  confirmGate(a, params);
  a.calc(['n'], 'OP_BIN2NUM', 'nN');
  a.calc(['d'], 'OP_BIN2NUM', 'dN');
  a.mark('delegate:depth<=DMAX');
  a.calc(['dN', { n: COV.DMAX - 1 }], 'OP_LESSTHANOREQUAL OP_VERIFY', null);
  a.calc(['dN', { n: 1 }], 'OP_ADD OP_4 OP_NUM2BIN', 'd2');
  a.calc(['R', 'holder'], 'OP_CAT OP_SHA256', 'R2');
  a.calc(['value'], 'OP_BIN2NUM', 'vN');
  a.mark('delegate:value');
  a.calc(['vA', { n: 0 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
  a.calc(['vA', 'vN'], 'OP_LESSTHANOREQUAL OP_VERIFY', null);
  for (const X of ['A', 'B']) {
    bounded(a, `n${X}`, false, `delegate:n${X}>=0`);
    bounded(a, `P${X}`, true);
    bounded(a, `T${X}`);
    a.mark(`delegate:pk${X}size`);
    a.calc([`pk${X}`], SIZE_IS('21'), null);
    a.mark(`delegate:P${X}subset`);
    a.calc([`P${X}`, 'P'], 'OP_AND', `_and${X}`);
    a.calc([`_and${X}`, `P${X}`], 'OP_EQUALVERIFY', null);
    a.mark(`delegate:T${X}<=T`);
    a.calc([`T${X}`, { n: 0 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
    a.calc([`T${X}`, 'TN'], 'OP_LESSTHANOREQUAL OP_VERIFY', null);
    a.calc([`T${X}`], 'OP_4 OP_NUM2BIN', `T${X}b`);
    a.calc([`n${X}`], 'OP_4 OP_NUM2BIN', `n${X}b`);
    a.calc([`pk${X}`, 'R2', `n${X}b`, `P${X}`, `T${X}b`, 'd2', { h: IDLE }, { h: ZERO_INTENT }], cat(8), `st${X}`);
  }
  a.mark('delegate:sum<=n');
  a.calc(['nA', 'nB'], 'OP_ADD', 'sumN');
  a.calc(['sumN', 'nN'], 'OP_LESSTHANOREQUAL OP_VERIFY', null);
  a.calc(['nN', 'sumN'], 'OP_SUB OP_4 OP_NUM2BIN', 'burn');
  a.calc(['vA'], 'OP_8 OP_NUM2BIN', 'vAb');
  a.calc(['vN', 'vA'], 'OP_SUB OP_8 OP_NUM2BIN', 'vBb');
  authOut(a, 'vAb', 'stA', 'oA');
  authOut(a, 'vBb', 'stB', 'oB');
  a.calc([{ h: BURN_HDR }, 'burn'], 'OP_CAT', 'oBurn');
  a.calc(['oA', 'oB', 'oBurn'], cat(3), 'outs');
  verifyOutputs(a, 'outs');
  a.finish();
}

const SLOTS = Array.from({ length: COV.DMAX - 1 }, (_, i) => `s${i + 1}`);

function reclaimPath(a) {
  ['sig', 'pkk', 'Rprev', 'k', ...SLOTS].forEach((nm, i) => (a.st[i] = nm));
  sigCheck(a, 'sig', 'pkk');
  a.mark('reclaim:sizes');
  a.calc(['pkk'], SIZE_IS('21'), null);
  a.calc(['Rprev'], SIZE_IS('20'), null);
  a.mark('reclaim:k>=1');
  a.calc(['k', { n: 1 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
  a.calc(['d'], 'OP_BIN2NUM', 'dN');
  a.mark('reclaim:k<=d');
  a.calc(['dN', 'k'], 'OP_SUB', 'j');
  a.calc(['j', { n: 0 }], 'OP_GREATERTHANOREQUAL OP_VERIFY', null);
  a.mark('reclaim:chain');
  a.calc(['Rprev', 'pkk'], 'OP_CAT OP_SHA256', 'acc');
  SLOTS.forEach((slot, i) => {
    a.calc(['j', { n: i + 1 }], 'OP_GREATERTHANOREQUAL', '_c');
    a.ifelse(
      (b) => {
        b.roll('acc');
        b.pick(slot, '_sl');
        b.raw(['OP_CAT', 'OP_SHA256'], 2, ['acc']);
      },
      (b) => b.roll('acc')
    );
  });
  a.mark('reclaim:chain=R');
  a.calc(['acc', 'R'], 'OP_EQUALVERIFY', null);
  a.calc(['k', { n: 1 }], 'OP_SUB OP_4 OP_NUM2BIN', 'd2');
  a.calc(['pkk', 'Rprev', 'n', 'P', 'T', 'd2', { h: IDLE }, { h: ZERO_INTENT }], cat(8), 'st2');
  authOut(a, 'value', 'st2', 'out');
  verifyOutputs(a, 'out');
  a.finish();
}

/** unlocking: <arg1..arg ARGS> <preimage> <path>。path: 0=使用確定 1=委任確定 2=奪還 3=予告。未使用の arg は OP_0 で埋める。 */
export const ARGS = 11 + 3 + 1 + COV.MERKLE_MAX;
export const PATH = Object.freeze({ USE: 0, DELEGATE: 1, RECLAIM: 2, ANNOUNCE: 3 });

function codeAsm(params, vintLength = 3) {
  const a = new Asm([...Array.from({ length: argCount(params) }, (_, i) => `x${i + 1}`), 'preimage', 'path']);
  pushTx(a);
  // preimage = version4 | hashPrevouts32 | hashSequence32 | outpoint36 | scriptCode | value8 | nSequence4 | hashOutputs32 | nLockTime4 | sighashType4
  a.roll('preimage');
  a.raw(['OP_4', 'OP_SPLIT', 'OP_NIP'], 1, ['_r']);
  a.raw(['20', 'OP_SPLIT'], 1, ['hPrev', '_r']);
  a.raw(['20', 'OP_SPLIT', 'OP_NIP'], 1, ['_r']);
  a.raw(['24', 'OP_SPLIT'], 1, ['outpoint', '_r']);
  a.calc(['outpoint'], 'OP_HASH256', '_oh');
  a.mark('single-input');
  a.calc(['hPrev', '_oh'], 'OP_EQUALVERIFY', null); // 入力は権限 UTXO 1本だけ（他の権限入力・手数料入力を許さない）
  a.drop('_oh');
  // outpoint is retained for the announcement Merkle proof.
  a.drop('hPrev');
  a.raw(['OP_SIZE', '34', 'OP_SUB', 'OP_SPLIT'], 1, ['sc', '_tail']);
  a.raw(['OP_8', 'OP_SPLIT'], 1, ['value', '_t']);
  a.raw(['OP_4', 'OP_SPLIT'], 1, ['seq', '_t']);
  a.raw(['20', 'OP_SPLIT'], 1, ['hOut', '_t']);
  a.raw(['OP_4', 'OP_SPLIT'], 1, ['lock', 'sigtype']);
  a.mark('sighash-type');
  a.calc(['sigtype', { h: '41000000' }], 'OP_EQUALVERIFY', null); // sighash 型 0x41 固定（hashOutputs を零にさせない）
  a.drop('sigtype');
  // scriptCode = varint(3 or 5) | push ヘッダ+状態(116) | OP_DROP CODE
  a.roll('sc');
  a.raw([numTok(vintLength), 'OP_SPLIT'], 1, ['vint', '_b']);
  a.raw([numTok(HDR_LEN), 'OP_SPLIT'], 1, ['hdrState', 'tail']);
  a.calc(['hdrState'], 'OP_2 OP_SPLIT OP_NIP', 'state');
  a.drop('hdrState');
  a.roll('state');
  for (const [name, len] of [['holder', '21'], ['R', '20'], ['n', 'OP_4'], ['P', 'OP_4'], ['T', 'OP_4'], ['d', 'OP_4'], ['phase', 'OP_1']]) {
    a.raw([len, 'OP_SPLIT'], 1, [name, '_rest']);
  }
  a.st[a.st.length - 1] = 'intent';
  ['n', 'P', 'T', 'd'].forEach((nm) => bounded(a, nm, true));
  a.mark('state:phase');
  a.calc(['phase', { h: IDLE }], 'OP_EQUAL', '_idle');
  a.calc(['phase', { n: 1 }], 'OP_EQUAL', '_ann');
  a.calc(['_idle', '_ann'], 'OP_BOOLOR OP_VERIFY', null);
  [...Array.from({ length: params.K + 1 }, (_, i) => `header${i}`), 'merkleIndex', ...Array.from({ length: COV.MERKLE_MAX }, (_, i) => `merkle${i}`)].forEach((nm, i) => a.st[11 + i] = nm);
  a.calc(['path'], 'OP_0 OP_NUMEQUAL', '_p0');
  a.ifelse(
    (b) => usePath(b, params),
    (b) => {
      b.calc(['path'], 'OP_1 OP_NUMEQUAL', '_p1');
      b.ifelse(
        (c) => delegatePath(c, params),
        (c) => {
          c.calc(['path'], 'OP_2 OP_NUMEQUAL', '_rpath');
          c.ifelse((d) => reclaimPath(d), (d) => {
            d.calc(['path'], 'OP_3 OP_NUMEQUALVERIFY', null);
            announcePath(d);
          });
        }
      );
    }
  );
  return { asm: a.toAsm(), labels: a.labels };
}

const BURN_HDR = '0000000000000000' + '07' + '006a04'; // 値0 ‖ 長さ7 ‖ OP_FALSE OP_RETURN push4（続けて枠4バイト）

const cachedCode = new Map();
function built(params = DEFAULT_PARAMS) {
  params = covParams(params);
  const key = `${params.K}:${params.target}`;
  if (!cachedCode.has(key)) {
    let code = codeAsm(params);
    if (LockingScript.fromASM(code.asm).toBinary().length + HDR_LEN + 1 > 65535) code = codeAsm(params, 5);
    cachedCode.set(key, code);
  }
  return cachedCode.get(key);
}
/** 状態以外のコードに発行時のKとtargetを固定する。 */
export function codeAsmCached(params = DEFAULT_PARAMS) { return built(params).asm; }
export function ruleAt(pc, params = DEFAULT_PARAMS) {
  const at = pc - 2;
  let name = 'prologue';
  for (const [pos, label] of built(params).labels) if (pos <= at) name = label;
  return name;
}
export function covLockingScript(state, params = DEFAULT_PARAMS) {
  return LockingScript.fromASM(`${encodeState(state)} OP_DROP ${codeAsmCached(params)}`);
}
