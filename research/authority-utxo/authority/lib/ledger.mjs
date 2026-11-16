import { createState } from './state.mjs';
import { validateAuthorityTx, OP } from './validate.mjs';

/**
 * @typedef {{ id: string, state: import('./state.mjs').AuthorityState }} LiveUtxo
 */

export class AuthorityLedger {
  /** @param {number} issuance */
  constructor(issuance) {
    this.issuance = issuance;
    this.consumedFrames = 0;
    /** @type {Map<string, LiveUtxo>} */
    this.utxos = new Map();
    /** @type {Set<string>} */
    this.spent = new Set();
    this.applyOrder = [];
  }

  /** @param {string} id @param {import('./state.mjs').AuthorityState} state */
  issue(id, state) {
    createState(state);
    if (this.utxos.has(id)) throw new Error('duplicate id');
    this.utxos.set(id, { id, state: createState(state) });
    return id;
  }

  totalFrames() {
    let sum = 0;
    for (const u of this.utxos.values()) sum += u.state.n;
    return sum;
  }

  conservationOk() {
    return this.totalFrames() === this.issuance - this.consumedFrames;
  }

  /**
   * @param {import('./validate.mjs').AuthorityTx} tx
   * @param {{ allowReplace?: boolean }} [opts]
   */
  apply(tx, opts = {}) {
    const spendId = tx.spend.id;
    if (this.spent.has(spendId) && !opts.allowReplace) {
      throw new Error('double spend');
    }
    if (!this.utxos.has(spendId)) throw new Error('unknown utxo');

    const result = validateAuthorityTx(tx);

    this.utxos.delete(spendId);
    this.spent.add(spendId);

    if (tx.op === OP.USE) {
      this.consumedFrames += result.used ?? 1;
      const out = tx.outputs[0];
      this.utxos.set(out.id, { id: out.id, state: createState(out.state) });
    } else if (tx.op === OP.DELEGATE) {
      const children = tx.childStates ?? tx.outputs?.map((o) => o.state);
      const allocated = children.reduce((sum, c) => sum + c.n, 0);
      this.consumedFrames += tx.spend.state.n - allocated;
      for (let i = 0; i < children.length; i++) {
        const id = tx.outputs?.[i]?.id ?? `${spendId}:d:${i}`;
        this.utxos.set(id, { id, state: createState(children[i]) });
      }
    } else if (tx.op === OP.REVOKE) {
      const merged = result.created[0];
      const targetId = tx.revokeTo.id;
      this.utxos.delete(targetId);
      this.utxos.set(targetId, { id: targetId, state: createState(merged.state) });
    }

    this.applyOrder.push(spendId);
    return result;
  }

  /** 競合: 先に apply できた方のみ有効 */
  tryApplyFirstValid(txs) {
    for (const tx of txs) {
      try {
        this.apply(tx);
        return { winner: tx, rejected: txs.filter((t) => t !== tx) };
      } catch {
        // try next — only one should succeed on same utxo if designed right
      }
    }
    throw new Error('no valid tx');
  }
}