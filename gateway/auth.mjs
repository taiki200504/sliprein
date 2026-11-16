import { createHash, createPrivateKey, createPublicKey, sign as ecdsaSign, verify as ecdsaVerify } from 'node:crypto';
export class Denied extends Error {}
export const requireThat = (ok, reason) => { if (!ok) throw new Denied(reason); };
const hash = body => createHash('sha256').update(body).digest('hex');
const privateKeys = new WeakMap();
export const publicKey = key => key.toPublicKey().toString();

export function validateID(id) {
  requireThat(typeof id === 'string' && /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/.test(id) && Number(id.split(':')[1]) <= 0xffffffff, 'invalid tranche');
}
export function keyObject(hex) {
  requireThat(typeof hex === 'string' && /^(02|03)[0-9a-f]{64}$/.test(hex), 'invalid public key');
  return createPublicKey({ key: Buffer.from('3036301006072a8648ce3d020106052b8104000a032200' + hex, 'hex'), format: 'der', type: 'spki' });
}
export function signingPayload(r) {
  validateID(r.tranche);
  requireThat(typeof r.method === 'string' && /^[A-Z]{1,16}$/.test(r.method), 'invalid method');
  requireThat(typeof r.path === 'string' && /^\/[\x21-\x7e]{0,1023}$/.test(r.path), 'invalid path');
  requireThat(typeof r.nonce === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(r.nonce), 'invalid nonce');
  requireThat((typeof r.body === 'string' || Buffer.isBuffer(r.body)) && Buffer.byteLength(r.body) <= 65536, 'invalid body');
  return JSON.stringify(['sliprein.gateway.v1', r.method, r.path, hash(r.body), r.nonce, r.tranche]);
}
export function sign(key, request) {
  if (!privateKeys.has(key)) {
    const secret = Buffer.from('302e0201010420' + key.toHex() + 'a00706052b8104000a', 'hex');
    try { privateKeys.set(key, { key: createPrivateKey({ key: secret, format: 'der', type: 'sec1' }), pub: publicKey(key) }); }
    finally { secret.fill(0); }
  }
  const pair = privateKeys.get(key);
  return { ...request, agentKey: pair.pub, signature: ecdsaSign('sha256', Buffer.from(signingPayload(request)), pair.key).toString('hex') };
}
export function verifySigned(request) {
  const payload = signingPayload(request);
  requireThat(typeof request.signature === 'string' && /^[0-9a-f]{16,144}$/.test(request.signature) && request.signature.length % 2 === 0, 'invalid signature');
  let valid = false;
  try { valid = ecdsaVerify('sha256', Buffer.from(payload), keyObject(request.agentKey), Buffer.from(request.signature, 'hex')); }
  catch { /* Invalid curve points and DER are authorization failures. */ }
  requireThat(valid, 'invalid signature');
  return payload;
}


export const ancestryRoot = keys => keys.reduce((R, key) => hash(Buffer.concat([Buffer.from(R, 'hex'), Buffer.from(key, 'hex')])), '00'.repeat(32));
