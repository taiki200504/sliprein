import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, MemoryLedger, sign, publicKey, createServer } from './index.mjs';
import { PrivateKey } from '@bsv/sdk';
const key = () => PrivateKey.fromRandom();
export async function fixture(n=10) {
 const a=key(), b=key(), agent=key(), gatewayKey=key(), chain=new MemoryLedger();
 const ancestors=[a,b,agent].map(publicKey);
 const id=chain.issue({holder:publicKey(gatewayKey),ancestors,n,P:1,T:2000000000});
 const g=new Gateway({key:gatewayKey,ledger:chain,now:()=>1800000000,operations:{'/mock':1,'/other':2}});
 await g.bind(id,ancestors);
 const req=(nonce, k=agent,path='/mock')=>sign(k,{tranche:id,method:'POST',path,body:'{}',nonce});
 return {g,a,b,agent,gatewayKey,chain,id,req,ancestors};
}
test('SQLite: valid signature, replay, wrong key and scope',async()=>{
 const {g,req}=await fixture(); assert.equal((await g.authorize(req('1'))).remaining,9);
 await assert.rejects(g.authorize(req('1'))); await assert.rejects(g.authorize(req('2',key())));
 await assert.rejects(g.authorize(req('3',undefined,'/other'))); g.close();
});
test('SQLite: exactly n of 100 concurrent calls, never negative',async()=>{
 const {g,req}=await fixture(17); const r=await Promise.allSettled(Array.from({length:100},(_,i)=>g.authorize(req(String(i)))));
 assert.equal(r.filter(x=>x.status==='fulfilled').length,17); assert.equal(g.status(req('x').tranche).remaining,0); g.close();
});
test('SQLite: ancestor stops one branch; sibling continues; outsider denied',async()=>{
 const {g,a,agent,chain,ancestors,gatewayKey,req,id}=await fixture();
 const sibling=chain.issue({holder:publicKey(gatewayKey),ancestors,n:3,P:1,T:2000000000}); await g.bind(sibling,ancestors);
 await assert.rejects(g.stop(sign(key(),{tranche:id,method:'POST',path:'/stop',body:'',nonce:'bad'})));
 await g.stop(sign(a,{tranche:id,method:'POST',path:'/stop',body:'',nonce:'stop'}));
 await assert.rejects(g.authorize(req('after')));
 const signed=sign(agent,{tranche:sibling,method:'POST',path:'/mock',body:'{}',nonce:'sibling'});
 assert.equal((await g.authorize(signed)).remaining,2);
 assert.equal(g.status(sibling).stopped,0); g.close();
});
test('SQLite: expiry, spent chain, mismatched ancestry and holder rejected',async()=>{
 const {g,req,chain,id,ancestors}=await fixture(); g.now=()=>2100000000; await assert.rejects(g.authorize(req('expired')));
 g.now=()=>1800000000; chain.spend(id); await assert.rejects(g.authorize(req('spent')));
 await assert.rejects(g.bind(id,ancestors.slice(1))); g.close();
});

test('SQLite: tampered method, path, body, nonce and tranche reject before debit',async()=>{
 const {g,req,id}=await fixture();
 for(const patch of [{method:'GET'},{path:'/other'},{body:'changed'},{nonce:'changed'},{tranche:'00'.repeat(32)+':0'}]) {
  await assert.rejects(g.authorize({...req('original'),...patch}));
 }
 assert.equal(g.status(id).remaining,10); g.close();
});
test('SQLite: all ancestor positions may stop; leaf depositor is an ancestor of bound output',async()=>{
 for(const who of ['a','b','agent']) {
  const f=await fixture(); await f.g.stop(sign(f[who],{tranche:f.id,method:'POST',path:'/stop',body:'',nonce:'stop'}));
  await assert.rejects(f.g.authorize(f.req('use'))); f.g.close();
 }
});
test('SQLite: monitor stops spent tranche and adapter failures fail closed',async()=>{
 const {g,chain,id,req}=await fixture(); chain.spend(id); await g.monitor(); assert.equal(g.status(id).stopped,1); g.close();
 const f=await fixture(); f.chain.isSpent=async()=>{throw Error('offline')};
 await assert.rejects(f.g.authorize(f.req('1'))); assert.equal(f.g.status(f.id).remaining,10); f.g.close();
});
test('SQLite: invalid ancestry, holder and duplicate binds reject',async()=>{
 const f=await fixture(); await assert.rejects(f.g.bind(f.id,f.ancestors));
 const id=f.chain.issue({holder:publicKey(f.gatewayKey),ancestors:f.ancestors,n:3,P:1,T:2000000000});
 await assert.rejects(f.g.bind(id,f.ancestors.slice(1)));
 const other=f.chain.issue({holder:publicKey(key()),ancestors:f.ancestors,n:3,P:1,T:2000000000}); await assert.rejects(f.g.bind(other,f.ancestors)); f.g.close(); f.chain.close();
});
test('SQLite: settle uses recorded count without a chain and creates residual tranche',async()=>{
 const {g,req,id,chain}=await fixture(); await g.authorize(req('1')); await g.authorize(req('2'));
 const r=await g.settle(id); assert.equal(r.ok,true); assert.equal(r.k,2); assert.equal(r.kind,'sqlite'); assert.equal(r.remaining,8);
 assert.equal(await chain.isSpent(id),true); assert.equal((await chain.readTranche(r.output.id)).n,8); await assert.rejects(g.authorize(req('3'))); g.close(); chain.close();
});
test('SQLite: HTTP forwards only authorized requests; stop and rate limit are enforced',async(t)=>{
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
test('SQLite: persistent database retains nonce, balance, audit and stop across instances',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'authority-gateway-')); const f=await fixture(); const file=join(dir,'gateway.sqlite');
 const opts={key:f.gatewayKey,ledger:f.chain,filename:file,now:()=>1800000000,operations:{'/mock':1}};
 let g=new Gateway(opts); await g.bind(f.id,f.ancestors); await g.authorize(f.req('one')); g.close();
 try {
  g=new Gateway(opts); assert.equal(g.status(f.id).remaining,9); await assert.rejects(g.authorize(f.req('one')));
  assert.equal(g.receipts(f.id).length,1); await g.stop(sign(f.a,{tranche:f.id,method:'POST',path:'/stop',body:'',nonce:'s'})); g.close();
  g=new Gateway(opts); await assert.rejects(g.authorize(f.req('two'))); assert.equal(g.status(f.id).stopped,1); g.close();
 } finally {f.g.close(); await rm(dir,{recursive:true,force:true})}
});
test('SQLite: signed request cannot change while awaiting chain verification',async()=>{
 const {g,req,id,chain}=await fixture(); const r=req('signed');
 let release; chain.isSpent=()=>new Promise(resolve=>{release=resolve});
 const pending=g.authorize(r); r.nonce='unsigned-change'; r.path='/other'; release(false);
 assert.equal((await pending).remaining,9);
 const payload=JSON.parse(g.receipts(id)[0].payload); assert.equal(payload[2],'/mock'); assert.equal(payload[4],'signed'); g.close();
});
test('SQLite: HTTP bind verifies depositor, ancestry and body signature',async(t)=>{
 const f=await fixture(); const id=f.chain.issue({holder:publicKey(f.gatewayKey),ancestors:f.ancestors,n:4,P:1,T:2000000000}); const server=createServer(f.g,{execute:async()=>({ok:true})});
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

test('SQLite: stop atomically queues unsettled k and settlement remains possible',async()=>{
 const f=await fixture(); await f.g.authorize(f.req('one')); await f.g.authorize(f.req('two'));
 await f.g.stop(sign(f.b,{tranche:f.id,method:'POST',path:'/stop',body:'',nonce:'stop'}));
 assert.equal(f.g.status(f.id).stopped,1); assert.deepEqual(f.g.pendingSettlements().map(r=>({id:r.tranche,k:r.k})),[{id:f.id,k:2}]);
 await assert.rejects(f.g.authorize(f.req('three'))); const r=await f.g.settle(f.id); assert.equal(r.k,2); assert.equal(r.remaining,8);
 assert.equal(f.g.pendingSettlements().length,0); assert.equal((await f.g.settle(f.id)).k,2); f.g.close(); f.chain.close();
});
test('SQLite: delegation preserves totals and rejects over-allocation and expansion',async()=>{
 const ledger=new MemoryLedger(), owner=key(), recipient=key();
 const id=ledger.issue({holder:publicKey(owner),n:10,P:1,T:2000000000});
 for(const patch of [{n:11},{P:3},{T:2100000000}]) assert.throws(()=>ledger.delegate(id,{key:owner,children:[{holder:publicKey(recipient),n:10,P:1,T:2000000000,...patch}]}));
 assert.equal(await ledger.isSpent(id),false);
 const result=ledger.delegate(id,{key:owner,children:[{holder:publicKey(recipient),n:6,P:1,T:2000000000},{holder:publicKey(recipient),n:4,P:1,T:2000000000}]});
 assert.equal(await ledger.isSpent(id),true); assert.equal((await ledger.readTranche(result.ids[0])).n+(await ledger.readTranche(result.ids[1])).n,10); ledger.close();
});
test('SQLite: default source is chain-free and durable with filename',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'authority-default-')); const filename=join(dir,'ledger.sqlite');
 const gatewayKey=key(), agent=key(), opts={key:gatewayKey,filename,now:()=>1800000000,operations:{'/mock':1}};
 try {
  let g=new Gateway(opts); const id=g.ledger.issue({holder:publicKey(gatewayKey),ancestors:[publicKey(agent)],n:2,P:1,T:2000000000});
  await g.bind(id,[publicKey(agent)]); await g.authorize(sign(agent,{tranche:id,method:'POST',path:'/mock',body:'',nonce:'1'}));
  await g.stop(sign(agent,{tranche:id,method:'POST',path:'/stop',body:'',nonce:'stop'})); g.close();
  g=new Gateway(opts); assert.equal(g.status(id).remaining,1); assert.equal(g.pendingSettlements()[0].k,1); assert.equal((await g.settle(id)).remaining,1); g.close();
 } finally {await rm(dir,{recursive:true,force:true})}
});
test('SQLite: gateway depends only on Ledger methods and settled flag',async()=>{
 const source=new MemoryLedger(), gatewayKey=key(), agent=key();
 const id=source.issue({holder:publicKey(gatewayKey),ancestors:[publicKey(agent)],n:2,P:1,T:2000000000});
 const ledger={readTranche:id=>source.readTranche(id),isSpent:id=>source.isSpent(id),settle:async(...args)=>({...await source.settle(...args),kind:'custom'})};
 const g=new Gateway({key:gatewayKey,ledger,now:()=>1800000000,operations:{'/mock':1}});
 await g.bind(id,[publicKey(agent)]); await g.authorize(sign(agent,{tranche:id,method:'POST',path:'/mock',body:'',nonce:'1'}));
 assert.equal((await g.settle(id)).kind,'custom'); assert.equal(g.pendingSettlements().length,0); assert.equal((await g.settle(id)).kind,'custom'); g.close(); source.close();
});
