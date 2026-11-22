import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { privateKeyHex } from './cli/state.mjs';

// ECDH#getPrivateKey drops leading zero bytes (about 1 in 256 keys), which then failed the strict
// 64-hex check in openState and made the suite flaky. The helper must always give 32 bytes.
test('generated gateway keys are always 64 hex characters and round-trip', () => {
  let short = 0;
  for (let i = 0; i < 4000; i++) {
    const ec = createECDH('secp256k1'); ec.generateKeys();
    if (ec.getPrivateKey().length < 32) short++;
    const hex = privateKeyHex(ec);
    assert.match(hex, /^[0-9a-f]{64}$/);
    const again = createECDH('secp256k1'); again.setPrivateKey(Buffer.from(hex, 'hex'));
    assert.equal(again.getPublicKey('hex', 'compressed'), ec.getPublicKey('hex', 'compressed'));
  }
  assert.ok(short > 0, 'the sample must include keys with a leading zero byte');
});
