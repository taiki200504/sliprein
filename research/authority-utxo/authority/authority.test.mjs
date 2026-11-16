import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  generateActor,
  AuthorityLedger,
  OP,
  validateDelegateShrinks,
  validateUse,
  validateAuthorityTx,
  verifyHolderSpendWithSdk,
  authorityLockingScript,
  isAuthorityLockingScript,
} from './lib/index.mjs';

const NOW = 1_700_000_000_000;
const FAR = NOW + 86_400_000;

function rootFixture(frames = 100, P = 0b1111) {
  const root = generateActor();
  const state = createState({ n: frames, P, T: FAR, R: [root.pubHash] });
  const ledger = new AuthorityLedger(frames);
  ledger.issue('root', state);
  return { root, state, ledger };
}

test('01 valid delegate passes shrink rules', () => {
  const { root, state, ledger } = rootFixture(20);
  const childA = generateActor();
  const childB = generateActor();
  const sA = createState({ n: 8, P: 0b1011, T: FAR - 1, R: [...state.R, childA.pubHash] });
  const sB = createState({ n: 7, P: 0b1001, T: FAR - 2, R: [...state.R, childB.pubHash] });
  assert.doesNotThrow(() => validateDelegateShrinks([sA, sB], state));
  ledger.apply({
    op: OP.DELEGATE,
    now: NOW,
    holderSig: true,
    spend: { id: 'root', state },
    childStates: [sA, sB],
    outputs: [
      { id: 'a', state: sA },
      { id: 'b', state: sB },
    ],
  });
  assert.equal(ledger.conservationOk(), true);
});

test('02 valid use consumes one frame', () => {
  const { root, state, ledger } = rootFixture(5);
  const next = createState({ n: 4, P: state.P, T: state.T, R: state.R });
  assert.equal(validateUse(next, state, 1), 1);
  ledger.apply({
    op: OP.USE,
    now: NOW,
    holderSig: true,
    useAmount: 1,
    spend: { id: 'root', state },
    outputs: [{ id: 'root2', state: next }],
  });
  assert.equal(ledger.utxos.get('root2').state.n, 4);
  assert.equal(ledger.conservationOk(), true);
});

test('03 valid revoke by ancestor merges frames', () => {
  const root = generateActor();
  const mid = generateActor();
  const leaf = generateActor();
  const rootState = createState({ n: 50, P: 0b1111, T: FAR, R: [root.pubHash] });
  const rootHold = createState({ n: 15, P: 0b1111, T: FAR, R: [root.pubHash] });
  const midState = createState({ n: 30, P: 0b1011, T: FAR, R: [...rootState.R, mid.pubHash] });
  const leafState = createState({ n: 12, P: 0b1001, T: FAR, R: [...midState.R, leaf.pubHash] });
  const ledger = new AuthorityLedger(50);
  ledger.issue('root', rootState);
  ledger.apply({
    op: OP.DELEGATE,
    now: NOW,
    holderSig: true,
    spend: { id: 'root', state: rootState },
    childStates: [midState, rootHold],
    outputs: [
      { id: 'mid', state: midState },
      { id: 'rootHold', state: rootHold },
    ],
  });
  ledger.apply({
    op: OP.DELEGATE,
    now: NOW,
    holderSig: true,
    spend: { id: 'mid', state: midState },
    childStates: [leafState],
    outputs: [{ id: 'leaf', state: leafState }],
  });
  const holdNow = ledger.utxos.get('rootHold').state;
  ledger.apply({
    op: OP.REVOKE,
    now: NOW,
    ancestorSig: true,
    ancestorHash: root.pubHash,
    spend: { id: 'leaf', state: leafState },
    revokeTo: { id: 'rootHold', state: holdNow },
  });
  assert.equal(ledger.utxos.get('rootHold').state.n, holdNow.n + leafState.n);
  assert.equal(ledger.utxos.has('leaf'), false);
  assert.equal(ledger.conservationOk(), true);
});

test('04 reject conservation violation on delegate', () => {
  const { state } = rootFixture(10);
  const child = generateActor();
  const tooBig = createState({ n: 11, P: state.P, T: state.T, R: [...state.R, child.pubHash] });
  assert.throws(() => validateDelegateShrinks([tooBig], state), /conservation/);
});

test('05 reject P expansion on delegate', () => {
  const { state } = rootFixture(10);
  const child = generateActor();
  const wide = createState({ n: 5, P: state.P | 0b10000, T: state.T, R: [...state.R, child.pubHash] });
  assert.throws(() => validateDelegateShrinks([wide], state), /shrink/);
});

test('06 reject T extension on delegate', () => {
  const { state } = rootFixture(10);
  const child = generateActor();
  const late = createState({ n: 5, P: state.P, T: state.T + 1, R: [...state.R, child.pubHash] });
  assert.throws(() => validateDelegateShrinks([late], state), /shrink/);
});

test('07 reject non-authority output (state leak)', () => {
  const { state } = rootFixture(10);
  const child = generateActor();
  const childState = createState({ n: 5, P: 0b1001, T: FAR - 1, R: [...state.R, child.pubHash] });
  assert.throws(
    () =>
      validateAuthorityTx({
        op: OP.DELEGATE,
        now: NOW,
        holderSig: true,
        spend: { id: 'x', state },
        childStates: [childState],
        outputs: [{ id: 'y', state: childState, lockingScriptHex: '51' }],
      }),
    /authority output/i
  );
});

test('08 reject revoke by non-ancestor', () => {
  const { state, ledger } = rootFixture(10);
  const stranger = generateActor();
  assert.throws(
    () =>
      ledger.apply({
        op: OP.REVOKE,
        now: NOW,
        ancestorSig: true,
        ancestorHash: stranger.pubHash,
        spend: { id: 'root', state },
        revokeTo: { id: 'root', state },
      }),
    /ancestor/
  );
});

test('09 reject double spend same utxo', () => {
  const { state, ledger } = rootFixture(10);
  const next = createState({ n: 9, P: state.P, T: state.T, R: state.R });
  const tx = {
    op: OP.USE,
    now: NOW,
    holderSig: true,
    spend: { id: 'root', state },
    outputs: [{ id: 'u2', state: next }],
  };
  ledger.apply(tx);
  assert.throws(() => ledger.apply({ ...tx, spend: { id: 'root', state } }), /double spend/);
});

test('10 use vs revoke race — first applied wins', () => {
  const root = generateActor();
  const holder = generateActor();
  const parent = createState({ n: 20, P: 0b111, T: FAR, R: [root.pubHash] });
  const branch = createState({ n: 8, P: 0b101, T: FAR, R: [...parent.R, holder.pubHash] });
  const rootHold = createState({ n: 6, P: parent.P, T: parent.T, R: parent.R });
  const ledger = new AuthorityLedger(20);
  ledger.issue('p', parent);
  ledger.apply({
    op: OP.DELEGATE,
    now: NOW,
    holderSig: true,
    spend: { id: 'p', state: parent },
    childStates: [branch, rootHold],
    outputs: [
      { id: 'b', state: branch },
      { id: 'rootHold', state: rootHold },
    ],
  });
  const useNext = createState({ n: 7, P: branch.P, T: branch.T, R: branch.R });
  const hold = ledger.utxos.get('rootHold').state;
  const useTx = {
    op: OP.USE,
    now: NOW,
    holderSig: true,
    spend: { id: 'b', state: branch },
    outputs: [{ id: 'b2', state: useNext }],
  };
  const revokeTx = {
    op: OP.REVOKE,
    now: NOW,
    ancestorSig: true,
    ancestorHash: root.pubHash,
    spend: { id: 'b', state: branch },
    revokeTo: { id: 'rootHold', state: hold },
  };
  const ledgerA = structuredCloneLedger(ledger);
  const ledgerB = structuredCloneLedger(ledger);
  ledgerA.apply(useTx);
  assert.throws(() => ledgerA.apply(revokeTx), /double spend|unknown utxo/);
  ledgerB.apply(revokeTx);
  assert.throws(() => ledgerB.apply(useTx), /double spend|unknown utxo/);
});

test('11 sibling branch still usable after revoke on other branch', () => {
  const root = generateActor();
  const a = generateActor();
  const b = generateActor();
  const parent = createState({ n: 40, P: 0b1111, T: FAR, R: [root.pubHash] });
  const sA = createState({ n: 15, P: 0b1011, T: FAR, R: [...parent.R, a.pubHash] });
  const sB = createState({ n: 12, P: 0b1001, T: FAR, R: [...parent.R, b.pubHash] });
  const rootHold = createState({ n: 8, P: parent.P, T: parent.T, R: parent.R });
  const ledger = new AuthorityLedger(40);
  ledger.issue('p', parent);
  ledger.apply({
    op: OP.DELEGATE,
    now: NOW,
    holderSig: true,
    spend: { id: 'p', state: parent },
    childStates: [sA, sB, rootHold],
    outputs: [
      { id: 'left', state: sA },
      { id: 'right', state: sB },
      { id: 'rootHold', state: rootHold },
    ],
  });
  const hold = ledger.utxos.get('rootHold').state;
  ledger.apply({
    op: OP.REVOKE,
    now: NOW,
    ancestorSig: true,
    ancestorHash: root.pubHash,
    spend: { id: 'left', state: ledger.utxos.get('left').state },
    revokeTo: { id: 'rootHold', state: hold },
  });
  const rightNext = createState({ n: 11, P: sB.P, T: sB.T, R: sB.R });
  assert.doesNotThrow(() =>
    ledger.apply({
      op: OP.USE,
      now: NOW,
      holderSig: true,
      spend: { id: 'right', state: ledger.utxos.get('right').state },
      outputs: [{ id: 'right2', state: rightNext }],
    })
  );
});

test('12 global frame accounting matches issuance minus consumption', () => {
  const { state, ledger } = rootFixture(30);
  const child = generateActor();
  const sC = createState({ n: 30, P: 0b1001, T: FAR, R: [...state.R, child.pubHash] });
  ledger.apply({
    op: OP.DELEGATE,
    now: NOW,
    holderSig: true,
    spend: { id: 'root', state },
    childStates: [sC],
    outputs: [{ id: 'c', state: sC }],
  });
  const cState = ledger.utxos.get('c').state;
  ledger.apply({
    op: OP.USE,
    now: NOW,
    holderSig: true,
    useAmount: 3,
    spend: { id: 'c', state: cState },
    outputs: [{ id: 'c2', state: createState({ n: 27, P: cState.P, T: cState.T, R: cState.R }) }],
  });
  assert.equal(ledger.consumedFrames, 3);
  assert.equal(ledger.totalFrames(), 27);
  assert.equal(ledger.conservationOk(), true);
});

test('13 SDK Spend.validate accepts holder signature on authority lock', async () => {
  const root = generateActor();
  const state = createState({ n: 3, P: 0b11, T: FAR, R: [root.pubHash] });
  const ls = authorityLockingScript(state, root.pubHash);
  assert.equal(isAuthorityLockingScript(ls), true);
  assert.equal(await verifyHolderSpendWithSdk({ privateKey: root.privateKey, state }), true);
});

/** @param {AuthorityLedger} ledger */
function structuredCloneLedger(ledger) {
  const next = new AuthorityLedger(ledger.issuance);
  next.consumedFrames = ledger.consumedFrames;
  for (const u of ledger.utxos.values()) next.issue(u.id, u.state);
  return next;
}
