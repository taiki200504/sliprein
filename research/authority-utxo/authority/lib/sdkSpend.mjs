import { Transaction, P2PKH, Spend } from '@bsv/sdk';
import { authorityLockingScript } from './script.mjs';
import { holderHash } from './state.mjs';

const SATOSHIS = 1;

/**
 * Holder が P2PKH パスで署名した spend を SDK Spend.validate で検証する。
 * メインネット送信は行わない。
 */
export async function verifyHolderSpendWithSdk({ privateKey, state, parentTxid, outputIndex = 0 }) {
  const lockingScript = authorityLockingScript(state, holderHash(state));
  const sourceTx = new Transaction(1, [], [{ satoshis: SATOSHIS, lockingScript }]);
  const sourceTxid = parentTxid ?? sourceTx.id('hex');

  const spendTx = new Transaction(1, [], [{ satoshis: SATOSHIS, lockingScript }]);
  spendTx.addInput({
    sourceTXID: sourceTxid,
    sourceOutputIndex: outputIndex,
    sequence: 0xffffffff,
    sourceTransaction: sourceTx,
  });
  const template = new P2PKH();
  const unlocker = template.unlock(privateKey, 'all', false, SATOSHIS, lockingScript);
  const unlockingScript = await unlocker.sign(spendTx, 0);
  spendTx.inputs[0].unlockingScript = unlockingScript;

  const spend = new Spend({
    sourceTXID: sourceTxid,
    sourceOutputIndex: outputIndex,
    sourceSatoshis: SATOSHIS,
    lockingScript,
    transactionVersion: spendTx.version,
    otherInputs: [],
    outputs: spendTx.outputs,
    inputIndex: 0,
    unlockingScript,
    inputSequence: 0xffffffff,
    lockTime: spendTx.lockTime,
  });

  return spend.validate();
}