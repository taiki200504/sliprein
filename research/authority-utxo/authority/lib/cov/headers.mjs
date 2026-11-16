// テスト用ブロックヘッダ採掘・Merkle（送信しないローカルのみ）
import { createHash } from 'node:crypto';

const sha256 = (buf) => createHash('sha256').update(buf).digest();
export const sha256d = (buf) => sha256(sha256(buf));

/** スクリプト固定の下限ターゲット（LE 数値比較）。nice -n 15 で数秒以内。 */
export const TEST_TARGET = 0x00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
export const TEST_BITS = 0x1d00ffff;

/** 80 バイトヘッダを組み立て（prev=32, merkle=32, time, bits, nonce）。 */
export function assembleHeader({ version = 1, prevHex, merkleHex, time = 0, bits = TEST_BITS, nonce = 0 }) {
  const b = Buffer.alloc(80);
  b.writeInt32LE(version, 0);
  Buffer.from(prevHex, 'hex').copy(b, 4);
  Buffer.from(merkleHex, 'hex').copy(b, 36);
  b.writeUInt32LE(time >>> 0, 68);
  b.writeUInt32LE(bits >>> 0, 72);
  b.writeUInt32LE(nonce >>> 0, 76);
  return b;
}

export function headerHashLE(header80) {
  const h = sha256d(header80);
  let n = 0n;
  for (let i = 0; i < 32; i++) n += BigInt(h[i]) << BigInt(8 * i);
  return n;
}

/** TEST_TARGET 以下になる nonce を探す（上限試行）。 */
export function mineHeader(fields, maxTries = 5_000_000, target = TEST_TARGET) {
  const partial = assembleHeader({ ...fields, nonce: 0 });
  for (let nonce = 0; nonce < maxTries; nonce++) {
    partial.writeUInt32LE(nonce, 76);
    if (headerHashLE(partial) <= target) {
      return { header: Buffer.from(partial), nonce };
    }
  }
  throw new Error('mineHeader: no nonce found');
}

/** 1 トランザクションのみのブロック Merkle 根（葉＝txid 32B の内部表現）。 */
export function merkleRootSingleLeaf(txidHex) {
  return Buffer.from(txidHex, 'hex');
}

/** K 個つなぐ（各ヘッダの prev = 前ブロック hash 内部バイト序）。 */
export function chainHeaders(K, announceTxidHex, timeStart = 1_700_000_000, target = TEST_TARGET) {
  const merkle = merkleRootSingleLeaf(announceTxidHex);
  const headers = [];
  let prev = Buffer.alloc(32, 0).toString('hex');
  for (let i = 0; i < K; i++) {
    const { header } = mineHeader({
      prevHex: prev,
      merkleHex: merkle.toString('hex'),
      time: timeStart + i * 600,
    }, 5_000_000, target);
    headers.push(header);
    prev = sha256d(header).toString('hex');
  }
  return headers;
}

/** 単一葉 Merkle 証明（分岐なし）。 */
export function merkleProofSingle() {
  return { siblings: [], index: 0 };
}