import { MemoryChain, BsvLedger, buildSettle } from '../research/authority-utxo/bsv.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, sign, publicKey, createServer } from './index.mjs';
import { PrivateKey } from '@bsv/sdk';
import { makeUtxo, deriveR, ROOT_R } from '../research/authority-utxo/authority/lib/cov/index.mjs';
const key = () => PrivateKey.fromRandom();
export async function fixture(n=10) {
 const a=key(), b=key(), agent=key(), gatewayKey=key(), chain=new MemoryChain();
 const ancestors=[a,b,agent].map(publicKey);
 const utxo=makeUtxo({state:{holder:publicKey(gatewayKey),R:ancestors.reduce(deriveR,ROOT_R),d:3,n,P:1,T:2000000000}});
 const id=`${utxo.txid}:0`; chain.put(utxo,{confirmations:1});
 const g=new Gateway({key:gatewayKey,ledger:new BsvLedger({chain}),now:()=>1800000000,operations:{'/mock':1,'/other':2}});
 await g.bind(id,ancestors);
 const req=(nonce, k=agent,path='/mock')=>sign(k,{tranche:id,method:'POST',path,body:'{}',nonce});
 return {g,a,b,agent,gatewayKey,chain,id,req,ancestors};
}
test('BSV: valid signature, replay, wrong key and scope',async()=>{
 const {g,req}=await fixture(); assert.equal((await g.authorize(req('1'))).remaining,9);
 await assert.rejects(g.authorize(req('1'))); await assert.rejects(g.authorize(req('2',key())));
 await assert.rejects(g.authorize(req('3',undefined,'/other'))); g.close();
});
test('BSV: exactly n of 100 concurrent calls, never negative',async()=>{
 const {g,req}=await fixture(17); const r=await Promise.allSettled(Array.from({length:100},(_,i)=>g.authorize(req(String(i)))));
 assert.equal(r.filter(x=>x.status==='fulfilled').length,17); assert.equal(g.status(req('x').tranche).remaining,0); g.close();
});
test('BSV: ancestor stops one branch; sibling continues; outsider denied',async()=>{
 const {g,a,agent,chain,ancestors,gatewayKey,req,id}=await fixture();
 const u=makeUtxo({state:{holder:publicKey(gatewayKey),R:ancestors.reduce(deriveR,ROOT_R),d:3,n:3,P:1,T:2000000000}}); chain.put(u,{confirmations:1});
 const sibling=`${u.txid}:0`; await g.bind(sibling,ancestors);
 await assert.rejects(g.stop(sign(key(),{tranche:id,method:'POST',path:'/stop',body:'',nonce:'bad'})));
 await g.stop(sign(a,{tranche:id,method:'POST',path:'/stop',body:'',nonce:'stop'}));
 await assert.rejects(g.authorize(req('after')));
 const signed=sign(agent,{tranche:sibling,method:'POST',path:'/mock',body:'{}',nonce:'sibling'});
 assert.equal((await g.authorize(signed)).remaining,2);
 assert.equal(g.status(sibling).stopped,0); g.close();
});
test('BSV: expiry, spent chain, mismatched ancestry and holder rejected',async()=>{
 const {g,req,chain,id,ancestors}=await fixture(); g.now=()=>2100000000; await assert.rejects(g.authorize(req('expired')));
 g.now=()=>1800000000; chain.spend(id); await assert.rejects(g.authorize(req('spent')));
 await assert.rejects(g.bind(id,ancestors.slice(1))); g.close();
});

test('BSV: tampered method, path, body, nonce and tranche reject before debit',async()=>{
 const {g,req,id}=await fixture();
 for(const patch of [{method:'GET'},{path:'/other'},{body:'changed'},{nonce:'changed'},{tranche:'00'.repeat(32)+':0'}]) {
  await assert.rejects(g.authorize({...req('original'),...patch}));
 }
 assert.equal(g.status(id).remaining,10); g.close();
});
test('BSV: all ancestor positions may stop; leaf depositor is an ancestor of bound output',async()=>{
 for(const who of ['a','b','agent']) {
  const f=await fixture(); await f.g.stop(sign(f[who],{tranche:f.id,method:'POST',path:'/stop',body:'',nonce:'stop'}));
  await assert.rejects(f.g.authorize(f.req('use'))); f.g.close();
 }
});
test('BSV: monitor stops spent tranche and adapter failures fail closed',async()=>{
 const {g,chain,id,req}=await fixture(); chain.spend(id); await g.monitor(); assert.equal(g.status(id).stopped,1); g.close();
 const f=await fixture(); f.chain.isSpent=async()=>{throw Error('offline')};
 await assert.rejects(f.g.authorize(f.req('1'))); assert.equal(f.g.status(f.id).remaining,10); f.g.close();
});
test('BSV: invalid or duplicate bind is rejected; state comes from locking script',async()=>{
 const {g,chain,id,ancestors}=await fixture();
 await assert.rejects(g.bind(id,ancestors));
 const add=async(patch,keys=ancestors)=>{
  const u=makeUtxo({state:{holder:publicKey(g.key),R:ancestors.reduce(deriveR,ROOT_R),d:3,n:3,P:1,T:2000000000,...patch}});
  chain.put(u,{confirmations:1}); await assert.rejects(g.bind(`${u.txid}:0`,keys));
 };
 await add({holder:publicKey(key())}); await add({},ancestors.slice(1)); await add({},[...ancestors.slice(0,2),publicKey(key())]);
 await add({phase:1});
 const u=makeUtxo({state:{holder:publicKey(g.key),R:ancestors.reduce(deriveR,ROOT_R),d:3,n:3,P:1,T:2000000000}});
 chain.put({...u,state:{...u.state,n:999}},{confirmations:1}); const newID=`${u.txid}:0`; await g.bind(newID,ancestors); assert.equal(g.status(newID).remaining,3); g.close();
});

test('BSV: settle freezes calls and uses exactly recorded usage',async()=>{
 const {g,req,id,gatewayKey}=await fixture(); await g.authorize(req('1')); await g.authorize(req('2'));
 const r=await g.settle(id,{lockTime:0}); assert.equal(r.ok,true); assert.equal(r.k,2); assert.equal(r.kind,'announce');
 assert.ok(r.transaction.toHex().length>0); await assert.rejects(g.authorize(req('3')));
 const {chainHeaders}=await import('../research/authority-utxo/authority/lib/cov/headers.mjs'); const pending=r.outputs[0];
 const headers=chainHeaders(pending.params.K+1,Buffer.from(pending.txid,'hex').reverse().toString('hex'),1700000000,pending.params.target);
 const confirmed=await buildSettle(pending,{key:gatewayKey,k:r.k,headers,lockTime:0});
 assert.equal(confirmed.ok,true); assert.equal(confirmed.outputs[0].state.n,8); g.close();
});

test('BSV: HTTP forwards only authorized requests; stop and rate limit are enforced',async(t)=>{
 const f=await fixture(); let forwarded=0;
 const server=createServer(f.g,{execute:async()=>({result:++forwarded}),rateLimit:4});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.g.close()});
 const base=`http://127.0.0.1:${server.address().port}`;
 const send=async(r)=>fetch(base+r.path,{method:r.method,body:r.body,headers:{'X-Tranche':r.tranche,'X-Agent-Key':r.agentKey,'X-Nonce':r.nonce,'X-Agent-Sig':r.signature}});
 assert.equal((await send(f.req('1'))).status,200); assert.equal(forwarded,1);
 assert.equal((await send(f.req('1'))).status,403); assert.equal(forwarded,1);
 assert.equal((await send(sign(f.a,{tranche:f.id,method:'POST',path:'/stop',body:'',nonce:'stop'}))).status,200);
 assert.equal((await send(f.req('2'))).status,403); assert.equal(forwarded,1);
 assert.equal((await send(f.req('3'))).status,429);
});
test('BSV: persistent database retains nonce, balance, audit and stop across instances',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'authority-gateway-')); const f=await fixture(); const file=join(dir,'gateway.sqlite');
 const opts={key:f.gatewayKey,ledger:new BsvLedger({chain:f.chain}),filename:file,now:()=>1800000000,operations:{'/mock':1}};
 let g=new Gateway(opts); await g.bind(f.id,f.ancestors); await g.authorize(f.req('one')); g.close();
 try {
  g=new Gateway(opts); assert.equal(g.status(f.id).remaining,9); await assert.rejects(g.authorize(f.req('one')));
  assert.equal(g.receipts(f.id).length,1); await g.stop(sign(f.a,{tranche:f.id,method:'POST',path:'/stop',body:'',nonce:'s'})); g.close();
  g=new Gateway(opts); await assert.rejects(g.authorize(f.req('two'))); assert.equal(g.status(f.id).stopped,1); g.close();
 } finally {f.g.close(); await rm(dir,{recursive:true,force:true})}
});
test('BSV: signed request cannot change while awaiting chain verification',async()=>{
 const {g,req,id,chain}=await fixture(); const r=req('signed');
 let release; chain.isSpent=()=>new Promise(resolve=>{release=resolve});
 const pending=g.authorize(r); r.nonce='unsigned-change'; r.path='/other'; release(false);
 assert.equal((await pending).remaining,9);
 const payload=JSON.parse(g.receipts(id)[0].payload); assert.equal(payload[2],'/mock'); assert.equal(payload[4],'signed'); g.close();
});
test('BSV: HTTP bind verifies depositor, ancestry and body signature',async(t)=>{
 const f=await fixture(); const u=makeUtxo({state:{holder:publicKey(f.gatewayKey),R:f.ancestors.reduce(deriveR,ROOT_R),d:3,n:4,P:1,T:2000000000}});
 const id=f.chain.put(u,{confirmations:1}); const server=createServer(f.g,{execute:async()=>({ok:true})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.g.close()});
 const base=`http://127.0.0.1:${server.address().port}`;
 const send=async(r)=>fetch(base+r.path,{method:r.method,body:r.body,headers:{'X-Tranche':r.tranche,'X-Agent-Key':r.agentKey,'X-Nonce':r.nonce,'X-Agent-Sig':r.signature}});
 const request={tranche:id,method:'POST',path:'/bind',body:JSON.stringify({ancestors:f.ancestors}),nonce:'bind'};
 assert.equal((await send(sign(f.a,request))).status,403);
 assert.equal((await send(sign(f.agent,request))).status,200);
 assert.equal(f.g.status(id).remaining,4);
 const modified=sign(f.agent,{...request,nonce:'modified'}); modified.body='{}'; assert.equal((await send(modified)).status,403);
});

test('BSV: bind rejects zero confirmations and requires policy K>=1',async()=>{
 const gatewayKey=key(), agent=key(), chain=new MemoryChain(), ancestors=[publicKey(agent)];
 const u=makeUtxo({state:{holder:publicKey(gatewayKey),R:ancestors.reduce(deriveR,ROOT_R),d:1,n:2,P:1,T:2000000000}});
 const id=chain.put(u,{confirmations:0}); const ledger=new BsvLedger({chain});
 const g=new Gateway({key:gatewayKey,ledger,operations:{'/mock':1},now:()=>1800000000});
 await assert.rejects(g.bind(id,ancestors),/confirmation/); assert.throws(()=>new BsvLedger({chain,minConfirmations:0}),/confirmation/); g.close();
});
test('BSV: stop records pending usage before settlement builder runs',async()=>{
 const f=await fixture(); await f.g.authorize(f.req('one')); await f.g.authorize(f.req('two'));
 await f.g.stop(sign(f.b,{tranche:f.id,method:'POST',path:'/stop',body:'',nonce:'stop'}));
 assert.equal(f.g.status(f.id).stopped,1); assert.equal(f.g.pendingSettlements()[0].k,2);
 const result=await f.g.settle(f.id); assert.equal(result.ok,true); assert.equal(result.k,2);
 assert.equal(f.g.pendingSettlements()[0].status,'built'); await assert.rejects(f.g.authorize(f.req('three'))); f.g.close();
});
