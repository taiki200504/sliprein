import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, execute, verifyReceipt } from './demo.mjs';

const rejects = (f, bundle=f.bundle, args=f.args) => {
 const before=structuredClone(f.env.state);
 assert.throws(()=>execute(bundle,args,f.env));
 assert.deepEqual(f.env.state,before); assert.equal(f.env.consumed.size,0);
};
test('01 update and receipt match grant',()=>{const f=fixture();const r=execute(f.bundle,f.args,f.env);assert.equal(f.env.state.record.status,'reviewed');assert.equal(f.env.state.record.revision,2);assert.equal(verifyReceipt(r,f.bundle,f.trust),true);});
test('02 forged approval',()=>{const f=fixture();f.bundle.signature='A'.repeat(86)+'==';rejects(f);});
test('03 modified arguments',()=>{const f=fixture();f.args.status='draft';rejects(f);});
for(const [n,key] of [[4,'tenant'],[5,'actor'],[6,'resource'],[7,'tool']]) test(`${n} context ${key}`,()=>{const f=fixture();f.env.context[key]='other';rejects(f);});
test('08 expiration boundary',()=>{const f=fixture();f.env.now=f.bundle.approval.expiresAt;rejects(f);const before=fixture();before.env.now=before.bundle.approval.expiresAt-1;assert.doesNotThrow(()=>execute(before.bundle,before.args,before.env));});
test('09 five-minute inclusive upper boundary',()=>{const f=fixture();f.bundle=f.issue({expiresAt:f.env.now+300000});assert.doesNotThrow(()=>execute(f.bundle,f.args,f.env));});
test('10 more than five minutes rejected',()=>{const f=fixture();f.bundle=f.issue({expiresAt:f.env.now+300001});rejects(f);});
test('11 replay',()=>{const f=fixture();execute(f.bundle,f.args,f.env);f.env.state={record:{tenant:f.env.context.tenant,id:'demo',status:'draft',revision:1}};const before=structuredClone(f.env.state);assert.throws(()=>execute(f.bundle,f.args,f.env));assert.deepEqual(f.env.state,before);assert.equal(f.env.consumed.size,1);});
test('12 revoked approval',()=>{const f=fixture();f.env.revoked.add(f.bundle.approval.approvalId);rejects(f);});
test('13 unknown policy',()=>{const f=fixture();f.bundle=f.issue({policyVersion:'unknown'});rejects(f);});
test('14 current permission downgrade',()=>{const f=fixture();f.env.allowedTools=new Set(['record.read']);rejects(f);});
test('15 permission upgrade does not widen old read grant',()=>{const f=fixture();f.bundle=f.issue({tool:'record.read'});f.env.allowedTools.add('record.read');rejects(f);});
test('16 stale record revision',()=>{const f=fixture();f.env.state.record.revision=2;rejects(f);});
test('17 result tampering and wrong grant/key',()=>{const f=fixture();const r=execute(f.bundle,f.args,f.env);const other=fixture();assert.equal(verifyReceipt(r,f.issue({approvalId:'another-approval'}),f.trust),false);assert.equal(verifyReceipt(r,other.bundle,f.trust),false);assert.equal(verifyReceipt(r,f.bundle,other.trust),false);r.result.status='draft';assert.equal(verifyReceipt(r,f.bundle,f.trust),false);});
test('18 strict schemas, types and bounds',()=>{for(const args of [{expectedRevision:1,status:'deleted'},{expectedRevision:0,status:'draft'},{expectedRevision:1,status:'reviewed',extra:1},{expectedRevision:1.5,status:'draft'},{expectedRevision:1,status:'x'.repeat(10000)}]){const f=fixture();rejects(f,f.bundle,args);}const f=fixture();f.bundle.approval.nonce='x'.repeat(129);rejects(f);});
test('19 bundle key cannot replace external trust',()=>{const f=fixture();const attacker=fixture();rejects(f,attacker.bundle);f.bundle.publicKey=attacker.trust.approvalPublicKey;rejects(f);});
test('20 record tenant/resource mismatch',()=>{for(const key of ['tenant','id']){const f=fixture();f.env.state.record[key]='other';rejects(f);}});
