import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openState } from './cli/state.mjs';
import { SqliteLedger } from './ledger.mjs';
import { createProxyServer } from './proxy.mjs';
const listen = s => new Promise(r => s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
function state(t) { const dir=mkdtempSync(join(tmpdir(),'scale-')); const s=openState(dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {s,dir}; }
test('SQLite and sidecars are private; unsafe existing database is rejected',t=>{
 const {s,dir}=state(t);s.issue('a');
 const path=join(dir,'library.sqlite');const ledger=new SqliteLedger({filename:path});assert.equal(statSync(path).mode&0o777,0o600);ledger.close();
 for(const file of ['state.sqlite','state.sqlite-wal','state.sqlite-shm']) assert.equal(statSync(join(dir,file)).mode&0o777,0o600);
 chmodSync(join(dir,'state.sqlite'),0o644);assert.throws(()=>openState(dir));chmodSync(join(dir,'state.sqlite'),0o600);
});
test('agent rate limit spans tokens and does not debit a rejected request',async t=>{
 const {s}=state(t);s.gateway.agentRateLimit=1;s.issue('a');const a=s.token('a'),b=s.token('a');
 const request={method:'POST',path:'/v1/chat/completions',body:'{}'};
 await s.gateway.authorizeBearer(a,request);await assert.rejects(s.gateway.authorizeBearer(b,request),/rate limit/);assert.equal(s.status('a').used,1);
});
test('receipt retention never permits replay of a live tranche and bounds expired cleanup',async t=>{
 const {s}=state(t);let now=1000;s.gateway.now=()=>now;s.issue('a',{T:2000});const token=s.token('a');
 await s.gateway.authorizeBearer(token,{method:'POST',path:'/v1/chat/completions',body:'{}'});
 assert.equal(s.gateway.pruneEvents(),0);
 const event=s.gateway.db.prepare('SELECT * FROM events').get();
 assert.throws(()=>s.gateway.record({tranche:event.tranche,nonce:event.nonce,signature:event.signature,agentKey:event.agent_key},'use',event.payload),/nonce replay/);
 assert.equal(s.gateway.receipts(s.status()[0]&&s.gateway.db.prepare('SELECT tranche FROM agents').get().tranche).length,1);
 now=2000+86401;assert.equal(s.gateway.pruneEvents(),1);assert.equal(s.gateway.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
});
test('health probe avoids authorization; active request limit and timeout release capacity',async t=>{
 const {s}=state(t);s.issue('a');const token=s.token('a');let calls=0;
 const upstream=createServer((req,res)=>{calls++;});await listen(upstream);
 const proxy=createProxyServer(s.gateway,{upstream:`http://127.0.0.1:${upstream.address().port}`,apiKey:'secret',maxConcurrent:1,timeoutMs:100});const base=await listen(proxy);
 t.after(()=>{for(const server of [proxy,upstream]){server.closeAllConnections();server.close();}});
 assert.equal((await fetch(base+'/healthz')).status,200);
 const send=()=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'});
 const first=send();while(!calls) await new Promise(r=>setTimeout(r,2));
 assert.equal((await send()).status,503);assert.equal((await first).status,502);assert.equal(s.status('a').used,1);
 assert.equal((await fetch(base+'/healthz')).status,200);
});
test('operator upstream prefix rejects ambiguous path encodings',t=>{
 const {s}=state(t);
 for(const suffix of ['/a/../b','/%2e%2e','/a%2fb','/a\\b']) assert.throws(()=>createProxyServer(s.gateway,{upstream:'https://example.com'+suffix,apiKey:'secret'}));
});
test('upstream connection pool queues requests within its bound',async t=>{
 const {s}=state(t);s.issue('a');const token=s.token('a');let active=0,peak=0;
 const upstream=createServer(async(req,res)=>{for await(const c of req){}active++;peak=Math.max(peak,active);setTimeout(()=>{active--;res.end('{}');},15);});await listen(upstream);
 const proxy=createProxyServer(s.gateway,{upstream:`http://127.0.0.1:${upstream.address().port}`,apiKey:'secret',maxUpstreamConnections:1});const base=await listen(proxy);
 t.after(()=>{for(const server of [proxy,upstream]){server.closeAllConnections();server.close();}});
 const results=await Promise.all(Array.from({length:5},async()=>{const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'});await res.text();return res.status;}));
 assert.deepEqual(results,[200,200,200,200,200]);assert.equal(peak,1);assert.equal(s.status('a').used,5);
});
