import { covLockingScript, spendAnnounceUse, spendConfirmUse } from './authority/lib/cov/index.mjs';
import { requireThat, validateID } from '../../gateway/auth.mjs';

/** Trusted adapter contract: async getUtxo(id) -> descriptor|undefined; async isSpent(id) -> boolean. */
export class MemoryChain {
  #utxos = new Map();
  #spent = new Set();
  put(utxo, { confirmations = 0 } = {}) { const id = `${utxo.txid}:${utxo.vout}`; validateID(id); requireThat(!this.#utxos.has(id), 'duplicate UTXO'); this.#utxos.set(id, { ...utxo, confirmations }); return id; }
  spend(id) { validateID(id); this.#spent.add(id); }
  async getUtxo(id) { return this.#spent.has(id) ? undefined : this.#utxos.get(id); }
  async isSpent(id) { return this.#spent.has(id); }
}
function stateFromScript(utxo) {
  const bytes = Buffer.from(utxo.script.toBinary());
  requireThat(bytes[0] === 0x4c && bytes[1] === 114 && bytes.length > 116, 'invalid covenant');
  const b = bytes.subarray(2, 116);
  const state = { holder: b.subarray(0, 33).toString('hex'), R: b.subarray(33, 65).toString('hex'),
    n: b.readUInt32LE(65), P: b.readUInt32LE(69), T: b.readUInt32LE(73), d: b.readUInt32LE(77),
    phase: b[81], intent: b.subarray(82, 114).toString('hex') };
  requireThat(covLockingScript(state, utxo.params).toHex() === utxo.script.toHex(), 'unknown covenant code');
  return state;
}

/** Builds only; confirmation requires chain-supplied headers/proof. Never broadcasts. */
export async function buildSettle(utxo, { key, k, lockTime = 0, headers, merkleProof }) {
  const state = stateFromScript(utxo);
  requireThat(Number.isInteger(k) && k >= 1 && k <= state.n, 'invalid settlement count');
  const kind = state.phase === 0 ? 'announce' : 'confirm';
  const result = await (kind === 'announce' ? spendAnnounceUse : spendConfirmUse)({ ...utxo, state }, { key, k, lockTime, headers, merkleProof });
  return { ...result, k, kind };
}

/** BSV is optional; the underlying adapter must attest canonical-chain confirmations. */
export class BsvLedger {
  constructor({ chain, minConfirmations = 1 }) {
    requireThat(Number.isInteger(minConfirmations) && minConfirmations >= 1, 'confirmations policy must be >=1');
    requireThat(chain && typeof chain.getUtxo === 'function' && typeof chain.isSpent === 'function', 'chain adapter required');
    this.chain = chain; this.minConfirmations = minConfirmations;
  }
  async readTranche(id) {
    validateID(id); const utxo = await this.chain.getUtxo(id);
    requireThat(utxo && `${utxo.txid}:${utxo.vout}` === id, 'missing UTXO');
    requireThat(Number.isInteger(utxo.confirmations) && utxo.confirmations >= this.minConfirmations, 'insufficient confirmations');
    return { ...stateFromScript(utxo), id };
  }
  async isSpent(id) {
    const spent = await this.chain.isSpent(id);
    if (spent === false) await this.readTranche(id);
    return spent;
  }
  async settle(id, k, options) {
    await this.readTranche(id);
    const utxo = await this.chain.getUtxo(id); requireThat(utxo, 'missing UTXO');
    const result = await buildSettle(utxo, { ...options, k });
    return { ...result, settled: false, record: result.ok ? { k, kind: result.kind, hex: result.transaction.toHex() } : undefined };
  }
}
