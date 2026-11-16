import { P2PKH, LockingScript } from '@bsv/sdk';
import { canonicalStateBytes, STATE_PREFIX } from './state.mjs';

/**
 * Locking script: commit authority state bytes, then P2PKH on current holder.
 * OP_PUSH_TX 型コベナントは未実装（検証は validate.mjs の取引検証関数）。
 */
export function authorityLockingScript(state, holderPubHash) {
  const payload = Buffer.concat([Buffer.from(STATE_PREFIX, 'utf8'), canonicalStateBytes(state)]);
  const p2 = new P2PKH();
  const holderBytes = [...Buffer.from(holderPubHash, 'hex')];
  const holderLock = p2.lock(holderBytes);
  const template = holderLock.toASM();
  const asm = `${payload.toString('hex')} OP_DROP ${template}`;
  return LockingScript.fromASM(asm);
}

export function isAuthorityLockingScript(lockingScriptOrHex) {
  const hex =
    typeof lockingScriptOrHex === 'string'
      ? lockingScriptOrHex
      : typeof lockingScriptOrHex?.toHex === 'function'
        ? lockingScriptOrHex.toHex()
        : '';
  const prefix = Buffer.from(STATE_PREFIX, 'utf8').toString('hex');
  return hex.toLowerCase().includes(prefix.toLowerCase());
}