// スクリプト強制版: ロックスクリプト自体が規則を強制することを @bsv/sdk の Spend.validate()（ローカル評価のみ）で確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivateKey } from '@bsv/sdk';
import {
  COV,
  ROOT_R,
  deriveR,
  makeUtxo,
  covLockingScript,
  announceAndConfirm,
  spendAnnounceUse,
  spendConfirmUse,

  spendReclaim,
} from './lib/cov/index.mjs';

const spendUse = (u, s) => announceAndConfirm(u, s);
const spendDelegate = (u, s) => announceAndConfirm(u, s, 1);
const U0 = 1_000_000;
const T0 = 2_000_000_000;
const key = () => PrivateKey.fromRandom();
const pk = (k) => k.toPublicKey().toString();

function rootUtxo({ owner = key(), n = 10, P = 0b1111, T = T0, U = U0, satoshis = 1000 } = {}) {
  const utxo = makeUtxo({ state: { holder: pk(owner), R: ROOT_R, n, P, T, U, d: 0 }, satoshis });
  return { owner, utxo };
}
const child = (holder, n, P, T = T0 - 10, v = 500) => ({ holder: pk(holder), n, P, T, v });

async function mustOk(p) {
  const r = await p;
  assert.equal(r.ok, true, `${r.failedRule}: ${r.error?.slice(0, 120)}`);
  return r;
}
/** 拒否されること、かつ「想定した規則」で落ちること（別の理由で偶然落ちていないこと）を確かめる。 */
async function mustFail(p, rule, note = '') {
  const r = await p;
  assert.equal(r.ok, false, `${note} rule violation was accepted`);
  assert.equal(r.failedRule, rule, `${note} rejected by '${r.failedRule}' (${r.error?.slice(0, 80)}), expected '${rule}'`);
  return r;
}

/** root → A（枠 6）, B（枠 4）。ledger の各出力を返す。 */
async function split(rootKey, root, a, b, extra = {}) {
  const kA = key();
  const kB = key();
  const r = await mustOk(
    spendDelegate(root, {
      key: rootKey,
      lockTime: U0 + 100,
      children: [child(kA, 6, 0b1011), child(kB, 4, 0b1001)],
      ...extra,
    })
  );
  return { kA, kB, A: r.outputs[0], B: r.outputs[1], burn: r.outputs[2], tx: r };
}

// ---- 委任 ----
test('C01 委任: 正例（枠合計=親・P縮小・T縮小・R=H(R‖委任者鍵)・idle）', async () => {
  const { owner, utxo } = rootUtxo();
  const s = await split(owner, utxo);
  assert.equal(s.A.state.n, 6);
  assert.equal(s.A.state.R, deriveR(ROOT_R, pk(owner)));
  assert.equal(s.A.state.d, 1);
  assert.equal(s.A.state.phase, 0);
});

test('C02 委任: 枠合計 < 親 は破棄として明示出力に残る（保存則の等式）', async () => {
  const { owner, utxo } = rootUtxo();
  const r = await mustOk(
    spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), 3, 0b1), child(key(), 2, 0b1)] })
  );
  assert.equal(r.burned, 5);
});

test('C03 委任: 枠合計 > 親 を拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  await mustFail(
    spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), 6, 0b1), child(key(), 5, 0b1)] }),
    'delegate:sum<=n'
  );
});

test('C04 委任: 片方の子が親枠を超えなくても合計超過なら拒否（各子≤親では足りない）', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  await mustFail(
    spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), 10, 0b1), child(key(), 10, 0b1)] }),
    'delegate:sum<=n'
  );
});

test('C05 委任: 負の枠を拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  await mustFail(
    spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), -5, 0b1), child(key(), 15, 0b1)] }),
    'delegate:nA>=0'
  );
});

test('C06 委任: P が親の部分集合でない子を拒否（P_child & P_parent == P_child）', async () => {
  const { owner, utxo } = rootUtxo({ P: 0b0101 });
  await mustFail(
    spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), 1, 0b0111), child(key(), 1, 0b0001)] }),
    'delegate:PAsubset'
  );
});

test('C07 委任: T が親より大きい子を拒否（T_child ≤ T_parent）', async () => {
  const { owner, utxo } = rootUtxo();
  await mustFail(
    spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), 1, 0b1, T0 + 1), child(key(), 1, 0b1)] }),
    'delegate:TA<=T'
  );
});

test('C08 委任: 子のコード部が自分と異なる出力を拒否', async () => {
  const { owner, utxo } = rootUtxo();
  await mustFail(
    spendDelegate(utxo, {
      key: owner,
      lockTime: U0 + 10,
      children: [child(key(), 3, 0b1), child(key(), 3, 0b1)],
      tamper: (outs) => outs.map((o, i) => (i === 0 ? { ...o, codeSwap: true } : o)),
    }),
    'confirm:intent'
  );
});

test('C09 委任: R_child が H(R_parent‖委任者鍵) でない出力を拒否', async () => {
  const { owner, utxo } = rootUtxo();
  await mustFail(
    spendDelegate(utxo, {
      key: owner,
      lockTime: U0 + 10,
      children: [child(key(), 3, 0b1), child(key(), 3, 0b1)],
      tamper: (outs) => outs.map((o, i) => (i === 0 ? { ...o, state: { ...o.state, R: deriveR(ROOT_R, pk(key())) } } : o)),
    }),
    'confirm:intent'
  );
});

test('C10 委任: 深さ DMAX を超える委任を拒否（奪還の開示長が有限であるため）', async () => {
  const owner = key();
  const utxo = makeUtxo({ state: { holder: pk(owner), R: deriveR(ROOT_R, pk(key())), n: 4, P: 1, T: T0, U: U0, d: COV.DMAX }, satoshis: 1000 });
  await mustFail(spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), 2, 1), child(key(), 2, 1)] }), 'delegate:depth<=DMAX');
});

test('C11 委任: 他人の署名を拒否、nLockTime は遅延に使わない', async () => {
  const { owner, utxo } = rootUtxo();
  const kids = [child(key(), 3, 1), child(key(), 3, 1)];
  await mustFail(spendDelegate(utxo, { key: key(), lockTime: 0, children: kids }), 'sig:sig');
  await mustOk(spendDelegate(utxo, { key: owner, lockTime: 0, sequence: 0xffffffff, children: kids }));
});

test('C12 委任: 値（satoshi）の合計が入力と異なる出力を拒否', async () => {
  const { owner, utxo } = rootUtxo({ satoshis: 1000 });
  await mustFail(
    spendDelegate(utxo, { key: owner, lockTime: U0 + 10, children: [child(key(), 3, 0b1, T0, 600), child(key(), 3, 0b1, T0, 600)] }),
    'hashOutputs'
  );
});

// ---- 使用 ----
test('C13 使用: 正例（枠を1つ減らした同型出力・idle）', async () => {
  const { owner, utxo } = rootUtxo({ n: 3 });
  const r = await mustOk(spendUse(utxo, { key: owner, lockTime: U0 + 5 }));
  assert.equal(r.outputs.length, 1);
  assert.equal(r.outputs[0].state.n, 2);
  assert.equal(r.outputs[0].state.phase, 0);
  const r2 = await mustOk(spendUse(r.outputs[0], { key: owner, lockTime: 0 }));
  assert.equal(r2.outputs[0].state.n, 1);
});

test('C14 使用: 枠 0 の使用を拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 0 });
  await mustFail(spendUse(utxo, { key: owner, lockTime: U0 + 5 }), 'use:n>=1');
});

test('C15 使用: 枠を減らさない・P を広げる・余り出力を足す改変を拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 3 });
  await mustFail(
    spendUse(utxo, { key: owner, lockTime: U0 + 5, tamper: (o) => [{ ...o[0], state: { ...o[0].state, n: 3 } }] }),
    'confirm:intent',
    'n not decremented'
  );
  await mustFail(
    spendUse(utxo, { key: owner, lockTime: U0 + 5, tamper: (o) => [{ ...o[0], state: { ...o[0].state, P: 0xff } }] }),
    'confirm:intent',
    'P widened'
  );
  await mustFail(spendUse(utxo, { key: owner, lockTime: U0 + 5, tamper: (o) => [...o, { ...o[0] }] }), 'confirm:intent', 'extra output');
});

test('C16 使用: 予告なしの直接使用・他人の署名を拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 3 });
  await mustFail(spendConfirmUse(utxo, { key: owner, lockTime: 0 }), 'confirm:phase');
  await mustFail(spendUse(utxo, { key: key(), lockTime: 0 }), 'sig:sig');
});

// ---- 祖先奪還 ----
/** root(k0) → A(kA) → AA(kAA) → AAA(kAAA)。各層の出力を返す。 */
async function chain(depth = 3, n = 8) {
  const keys = [key()];
  let { utxo } = rootUtxo({ owner: keys[0], n });
  const utxos = [utxo];
  for (let i = 0; i < depth; i++) {
    const holder = key();
    keys.push(holder);
    const prev = utxos[i];
    const r = await mustOk(
      spendDelegate(prev, {
        key: keys[i],
        lockTime: 0,
        children: [{ holder: pk(holder), n: prev.state.n, P: prev.state.P, T: prev.state.T, v: prev.satoshis }, { holder: pk(key()), n: 0, P: prev.state.P, T: prev.state.T, v: 0 }],
      })
    );
    utxos.push(r.outputs[0]);
  }
  return { keys, utxos };
}

test('C17 奪還: 親（k=1）が遅延なしで子の残枠を回収、枠/P/T 不変・R は接頭辞', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  const s = await split(owner, utxo);
  const r = await mustOk(spendReclaim(s.A, { key: owner, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 }));
  const o = r.outputs[0].state;
  assert.equal(o.n, s.A.state.n);
  assert.equal(o.P, s.A.state.P);
  assert.equal(o.T, s.A.state.T);
  assert.equal(o.holder, pk(owner));
  assert.equal(o.R, ROOT_R);
  assert.equal(o.d, 0);
});

test('C18 奪還: 深い枝の根が全中間を飛ばして回収し、中間祖先は切られる', async () => {
  const { keys, utxos } = await chain(3);
  const leaf = utxos[3];
  // 根（k=1）: 開示は pk_2, pk_3（=keys[1], keys[2]）
  const r = await mustOk(
    spendReclaim(leaf, { key: keys[0], k: 1, Rprev: ROOT_R, chain: [pk(keys[1]), pk(keys[2])], lockTime: 0 })
  );
  assert.equal(r.outputs[0].state.R, ROOT_R);
  assert.equal(r.outputs[0].state.d, 0);
  // 中間祖先 keys[1] は、切られた後の出力を奪い返せない
  const reclaimed = r.outputs[0];
  await mustFail(
    spendReclaim(reclaimed, { key: keys[1], k: 2, Rprev: deriveR(ROOT_R, pk(keys[0])), chain: [], lockTime: 0 }),
    'reclaim:k<=d',
    'cut-off ancestor（奪還後の出力は深さ 0）'
  );
});

test('C19 奪還: 中間祖先（k=2）も自分より下だけを回収できる', async () => {
  const { keys, utxos } = await chain(3);
  const Rprev = deriveR(ROOT_R, pk(keys[0]));
  const r = await mustOk(spendReclaim(utxos[3], { key: keys[1], k: 2, Rprev, chain: [pk(keys[2])], lockTime: 0 }));
  assert.equal(r.outputs[0].state.R, Rprev);
  assert.equal(r.outputs[0].state.d, 1);
});

test('C20 奪還: 兄弟の鍵を祖先と偽る奪還を拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  const s = await split(owner, utxo);
  // B の保有者が、A の出力を「自分は祖先」と偽って奪う（自分の枝の接頭辞で）
  await mustFail(spendReclaim(s.A, { key: s.kB, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 }), 'reclaim:chain=R', 'sibling as ancestor');
  // 保有者自身（祖先列に居ない）も不可
  await mustFail(spendReclaim(s.A, { key: s.kA, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 }), 'reclaim:chain=R', 'holder as ancestor');
});

test('C21 奪還: 位置 k の偽り・開示列の改ざんを拒否', async () => {
  const { keys, utxos } = await chain(3);
  const leaf = utxos[3];
  const ok = { key: keys[0], k: 1, Rprev: ROOT_R, chain: [pk(keys[1]), pk(keys[2])], lockTime: 0 };
  await mustOk(spendReclaim(leaf, ok));
  await mustFail(spendReclaim(leaf, { ...ok, k: 2 }), 'reclaim:chain=R', 'wrong k');
  await mustFail(spendReclaim(leaf, { ...ok, chain: [pk(keys[1])] }), 'reclaim:chain=R', 'truncated chain');
  await mustFail(spendReclaim(leaf, { ...ok, chain: [pk(keys[2]), pk(keys[1])] }), 'reclaim:chain=R', 'reordered chain');
  await mustFail(spendReclaim(leaf, { ...ok, chain: [pk(keys[1]), pk(key())] }), 'reclaim:chain=R', 'inserted key');
});

test('C22 奪還: 枠・P・T を増やす奪還出力を拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  const s = await split(owner, utxo);
  const base = { key: owner, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 };
  for (const patch of [{ n: s.A.state.n + 1 }, { P: 0b1111 }, { T: T0 }]) {
    await mustFail(
      spendReclaim(s.A, { ...base, tamper: (o) => [{ ...o[0], state: { ...o[0].state, ...patch } }] }),
      'hashOutputs',
      `inflated ${Object.keys(patch)}`
    );
  }
  await mustFail(spendReclaim(s.A, { ...base, tamper: (o) => [...o, { ...o[0] }] }), 'hashOutputs', 'extra output');
});

test('C23 奪還: 他人の署名・署名型違いを拒否', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  const s = await split(owner, utxo);
  await mustFail(spendReclaim(s.A, { key: owner, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0, signWith: key() }), 'sig:sig', 'forged sig');
});

test('C24 兄弟枝: 一方を奪還しても他方の出力はそのまま使える', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  const s = await split(owner, utxo);
  await mustOk(spendReclaim(s.A, { key: owner, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0 }));
  const useB = await mustOk(spendUse(s.B, { key: s.kB, lockTime: 0 }));
  assert.equal(useB.outputs[0].state.n, s.B.state.n - 1);
});

test('C25 予告中は各祖先が遅延なしで奪還できる', async () => {
  const { keys, utxos } = await chain(3);
  const r = await mustOk(spendAnnounceUse(utxos[3], { key: keys[3], lockTime: 0 }));
  let Rk = ROOT_R;
  for (let k = 1; k <= 3; k++) {
    await mustOk(spendReclaim(r.outputs[0], { key: keys[k - 1], k, Rprev: Rk, chain: keys.slice(k, 3).map(pk), lockTime: 0 }));
    Rk = deriveR(Rk, pk(keys[k - 1]));
  }
});

test('C26 深さ DMAX の枝でも根は奪還できる', async () => {
  const { keys, utxos } = await chain(COV.DMAX, 4);
  const leaf = utxos[COV.DMAX];
  await mustOk(spendReclaim(leaf, { key: keys[0], k: 1, Rprev: ROOT_R, chain: keys.slice(1, COV.DMAX).map(pk), lockTime: 0 }));
});

test('C27 ロックスクリプトは状態以外が全出力で同一（コード部固定）', () => {
  const a = covLockingScript({ holder: pk(key()), R: ROOT_R, n: 1, P: 1, T: T0, U: U0, d: 0 });
  const b = covLockingScript({ holder: pk(key()), R: deriveR(ROOT_R, pk(key())), n: 9, P: 7, T: T0 - 1, U: U0 + 5, d: 3 });
  assert.equal(a.toHex().length, b.toHex().length);
  assert.equal(a.toHex().slice(-200), b.toHex().slice(-200));
});

// ---- 土台の強制（OP_PUSH_TX・単一入力・署名型） ----
test('C28 preimage を偽装した取引を拒否（OP_PUSH_TX が実 sighash との一致を強制）', async () => {
  const { owner, utxo } = rootUtxo({ n: 3 });
  await mustFail(spendUse(utxo, { key: owner, lockTime: U0 + 5, mutatePreimage: (p) => p.with(p.length - 8, p[p.length - 8] ^ 1) }), 'pushtx');
});

test('C29 権限入力の他に入力がある取引を拒否（別の権限入力・手数料入力の混入を防ぐ）', async () => {
  const { owner, utxo } = rootUtxo({ n: 3 });
  await mustFail(spendUse(utxo, { key: owner, lockTime: U0 + 5, extraInput: true }), 'single-input');
});

test('C30 署名型が ALL|FORKID(0x41) でない署名を拒否（出力を署名に縛る）', async () => {
  const { owner, utxo } = rootUtxo({ n: 10 });
  const s = await split(owner, utxo);
  await mustFail(spendReclaim(s.A, { key: owner, k: 1, Rprev: ROOT_R, chain: [], lockTime: 0, sigScope: 0x42 }), 'sig:sig');
});
