import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PrivateKey} from '@bsv/sdk';
import {makeUtxo,ROOT_R,announceAndConfirm} from './lib/cov/index.mjs';
for(const k of [1,3,0,4]) test(`USE_K k=${k}`,async()=>{
 const key=PrivateKey.fromRandom(); const u=makeUtxo({state:{holder:key.toPublicKey().toString(),R:ROOT_R,n:3,P:1,T:2000000000,d:0}});
 const r=await announceAndConfirm(u,{key,k,lockTime:0}); assert.equal(r.ok,k>=1&&k<=3); if(r.ok) assert.equal(r.outputs[0].state.n,3-k);
});
for(const patch of [{P:3},{T:2100000000}]) test(`USE_K rejects expansion ${Object.keys(patch)}`,async()=>{
 const key=PrivateKey.fromRandom(); const u=makeUtxo({state:{holder:key.toPublicKey().toString(),R:ROOT_R,n:3,P:1,T:2000000000,d:0}});
 const r=await announceAndConfirm(u,{key,k:2,lockTime:0,tamper:o=>[{...o[0],state:{...o[0].state,...patch}}]}); assert.equal(r.ok,false);
});
for(const patch of [{P:3},{T:2100000000}]) test(`USE_K rejects precommitted expansion ${Object.keys(patch)}`,async()=>{
 const {spendAnnounce,intentHash,spendConfirmUse}=await import('./lib/cov/index.mjs');
 const {chainHeaders}=await import('./lib/cov/headers.mjs');
 const key=PrivateKey.fromRandom(); const u=makeUtxo({state:{holder:key.toPublicKey().toString(),R:ROOT_R,n:3,P:1,T:2000000000,d:0}});
 const spec={key,k:2,lockTime:0};
 const a=await spendAnnounce(u,{...spec,intent:intentHash({...u,state:{...u.state,...patch}},spec)});
 assert.equal(a.ok,true); const pending=a.outputs[0];
 const headers=chainHeaders(pending.params.K+1,Buffer.from(pending.txid,'hex').reverse().toString('hex'),1700000000,pending.params.target);
 const r=await spendConfirmUse(pending,{...spec,headers,tamper:o=>[{...o[0],state:{...o[0].state,...patch}}]});
 assert.equal(r.ok,false); assert.equal(r.failedRule,'hashOutputs');
});
