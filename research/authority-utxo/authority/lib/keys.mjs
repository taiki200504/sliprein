import { PrivateKey } from '@bsv/sdk';

/** @typedef {{ privateKey: import('@bsv/sdk').default.PrivateKey, pubHash: string }} ActorKey */

/** @returns {ActorKey} */
export function generateActor() {
  const privateKey = PrivateKey.fromRandom();
  const pubHash = privateKey.toPublicKey().toHash('hex');
  return { privateKey, pubHash };
}

/** @param {import('@bsv/sdk').default.PrivateKey} privateKey */
export function pubHashOf(privateKey) {
  return privateKey.toPublicKey().toHash('hex');
}