import { createState, isShrinkOf, hasAncestor } from './state.mjs';
import { isAuthorityLockingScript } from './script.mjs';

export const OP = {
  DELEGATE: 'delegate',
  USE: 'use',
  REVOKE: 'revoke',
};

/**
 * @typedef {{ id: string, state: import('./state.mjs').AuthorityState, lockingScriptHex?: string }} UtxoRef
 * @typedef {{
 *   op: string,
 *   spend: UtxoRef,
 *   outputs?: UtxoRef[],
 *   useAmount?: number,
 *   childStates?: import('./state.mjs').AuthorityState[],
 *   revokeTo?: UtxoRef,
 *   ancestorHash?: string,
 *   now: number,
 *   holderSig?: boolean,
 *   ancestorSig?: boolean,
 * }} AuthorityTx
 */

function assertAuthorityOutput(state) {
  createState(state); // throws if malformed
}

/** @param {AuthorityState[]} children @param {AuthorityState} parent */
export function validateDelegateShrinks(children, parent) {
  if (children.length === 0) throw new Error('delegate requires children');
  let sum = 0;
  for (const child of children) {
    assertAuthorityOutput(child);
    if (!isShrinkOf(child, parent)) throw new Error('child not shrink of parent');
    const extendsR =
      child.R.length === parent.R.length + 1 && parent.R.every((h, i) => h === child.R[i]);
    const sameLine = child.R.length === parent.R.length && parent.R.every((h, i) => h === child.R[i]);
    if (!extendsR && !sameLine) throw new Error('child R must extend parent R');
    sum += child.n;
  }
  if (sum > parent.n) throw new Error('conservation: child frames exceed parent');
  return true;
}

/** @param {import('./state.mjs').AuthorityState} next @param {import('./state.mjs').AuthorityState} prev @param {number} useAmount */
export function validateUse(next, prev, useAmount = 1) {
  assertAuthorityOutput(next);
  if (!Number.isSafeInteger(useAmount) || useAmount < 1) throw new Error('invalid useAmount');
  if (useAmount > prev.n) throw new Error('use exceeds frame');
  if (next.n !== prev.n - useAmount) throw new Error('use frame mismatch');
  if (next.P !== prev.P || next.T !== prev.T) throw new Error('use changed P or T');
  if (next.R.length !== prev.R.length || !prev.R.every((h, i) => h === next.R[i])) {
    throw new Error('use changed ancestry');
  }
  return useAmount;
}

/** @param {AuthorityTx} tx */
export function validateAuthorityTx(tx) {
  if (tx.now > tx.spend.state.T) throw new Error('expired');

  if (tx.op === OP.DELEGATE) {
    if (!tx.holderSig) throw new Error('delegate requires holder signature');
    const children = tx.childStates ?? tx.outputs?.map((o) => o.state) ?? [];
    validateDelegateShrinks(children, tx.spend.state);
    for (const o of tx.outputs ?? []) {
      if (o.lockingScriptHex && !isAuthorityLockingScript(o.lockingScriptHex)) {
        throw new Error('non-authority output type');
      }
    }
    return { consumed: [tx.spend.id], created: children.map((_, i) => `${tx.spend.id}:child:${i}`) };
  }

  if (tx.op === OP.USE) {
    if (!tx.holderSig) throw new Error('use requires holder signature');
    const amount = validateUse(tx.outputs[0].state, tx.spend.state, tx.useAmount ?? 1);
    return { consumed: [tx.spend.id], created: [tx.outputs[0].id], used: amount };
  }

  if (tx.op === OP.REVOKE) {
    if (!tx.ancestorHash || !hasAncestor(tx.ancestorHash, tx.spend.state)) {
      throw new Error('revoke requires ancestor in R');
    }
    if (!tx.ancestorSig) throw new Error('revoke requires ancestor signature');
    if (!tx.revokeTo || !hasAncestor(tx.ancestorHash, tx.revokeTo.state)) {
      throw new Error('revoke target must be ancestor UTXO');
    }
    const merged = createState({
      n: tx.revokeTo.state.n + tx.spend.state.n,
      P: tx.spend.state.P,
      T: Math.min(tx.revokeTo.state.T, tx.spend.state.T),
      R: tx.revokeTo.state.R.slice(0, tx.revokeTo.state.R.indexOf(tx.ancestorHash) + 1),
    });
    if (!isShrinkOf(merged, tx.revokeTo.state) && merged.P === tx.revokeTo.state.P) {
      // merged n increased; P/T must not expand beyond ancestor line
    }
    if ((merged.P & tx.revokeTo.state.P) !== merged.P) throw new Error('revoke P expansion');
    if (merged.T > tx.revokeTo.state.T) throw new Error('revoke T extension');
    return {
      consumed: [tx.spend.id],
      created: [{ state: merged, id: tx.revokeTo.id }],
      merged: true,
    };
  }

  throw new Error('unknown op');
}