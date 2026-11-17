import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { Gateway, MemoryLedger, publicKey } from './index.mjs';
import { PrivateKey } from '@bsv/sdk';
async function fixture() {
 const a=PrivateKey.fromRandom(),agent=PrivateKey.fromRandom(),key=PrivateKey.fromRandom();
 const chain=new MemoryLedger(),ancestors=[a,agent].map(publicKey);
 const id=chain.issue({holder:publicKey(key),ancestors,n:10,P:1,T:2000000000});
 const g=new Gateway({key,ledger:chain,operations:{'/mock':1,'/other':2}});await g.bind(id,ancestors);
 return {g,a,agent,id};
}
import { createProxyServer } from './proxy.mjs';
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
test('bearer proxy relays JSON, SSE, status and never forwards agent credentials', async t => {
 const f = await fixture(); f.g.operations = {'POST /v1/chat/completions':1};
 let calls=0;
 const upstream=httpServer(async(req,res)=>{
  calls++; assert.equal(req.headers.authorization,'Bearer upstream-secret');
  assert.equal(req.headers['x-agent-key'],undefined);
  let body=''; for await(const chunk of req) body+=chunk;
  assert.equal(JSON.parse(body).model,'mock');
  res.writeHead(201,{'content-type':'text/event-stream','x-request-id':'test','set-cookie':'private=1'});
  res.write('data: {"ok":true}\n\n'); setTimeout(()=>res.end('data: [DONE]\n\n'),20);
 });
 const url=await listen(upstream);
 const proxy=createProxyServer(f.g,{upstream:url,apiKey:'upstream-secret'}); const base=await listen(proxy);
 t.after(()=>{proxy.closeAllConnections();proxy.close();upstream.closeAllConnections();upstream.close();f.g.close();});
 const token=f.g.issueToken(f.id,f.agent.toPublicKey().toString());
 const send=tok=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:'{"model":"mock","stream":true}'});
 assert.equal((await send('invalid')).status,401);
 const response=await send(token);assert.equal(response.status,201);assert.equal(response.headers.get('set-cookie'),null);
 assert.match(await response.text(),/\[DONE\]/); assert.equal(calls,1); assert.equal(f.g.status(f.id).used,1);
 f.g.db.prepare('UPDATE tranches SET stopped=1 WHERE id=?').run(f.id);
 assert.equal((await send(token)).status,403);assert.equal(calls,1);
});
test('tokens are bound to an agent key, hashed at rest and scope enforced',async()=>{
 const f=await fixture();
 assert.throws(()=>f.g.issueToken(f.id,f.a.toPublicKey().toString()));
 const token=f.g.issueToken(f.id,f.agent.toPublicKey().toString());
 assert.ok(!JSON.stringify(f.g.db.prepare('SELECT * FROM agent_tokens').all()).includes(token));
 await assert.rejects(f.g.authorizeBearer(token,{method:'POST',path:'/other',body:'{}'}));
 assert.equal((await f.g.authorizeBearer(token,{method:'POST',path:'/mock',body:'{}'})).remaining,9);
 f.g.close();
});

test('signed-header proxy requests remain supported and route tampering fails closed',async t=>{
 const {sign}=await import('./auth.mjs');const f=await fixture();f.g.operations={'POST /v1/chat/completions':1};
 let calls=0;const upstream=httpServer((req,res)=>{calls++;res.end('{"ok":true}');});const url=await listen(upstream);
 const proxy=createProxyServer(f.g,{upstream:url,apiKey:'server-only'});const base=await listen(proxy);
 t.after(()=>{proxy.closeAllConnections();proxy.close();upstream.closeAllConnections();upstream.close();f.g.close();});
 const r=sign(f.agent,{tranche:f.id,method:'POST',path:'/v1/chat/completions',body:'{}',nonce:'signed-proxy'});
 const headers={'x-tranche':r.tranche,'x-agent-key':r.agentKey,'x-nonce':r.nonce,'x-agent-sig':r.signature};
 assert.equal((await fetch(base+r.path,{method:'POST',headers,body:'{}'})).status,200);
 assert.equal((await fetch(base+r.path,{method:'POST',headers,body:'{}'})).status,403);
 for(const path of ['/v1/chat/completions?target=elsewhere','/stop','/bind','//other.example/v1/chat/completions']) {
  assert.equal((await fetch(base+path,{method:'POST',headers,body:'{}'})).status,403);
 }
 assert.equal(calls,1);
});
test('SSE reaches the client before upstream completion; disconnect cancels upstream',async t=>{
 const f=await fixture();f.g.operations={'POST /v1/chat/completions':1};
 let finish,disconnected;const closed=new Promise(r=>disconnected=r);
 const upstream=httpServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');
  finish=setTimeout(()=>res.end('data: last\n\n'),2000);res.on('close',()=>{clearTimeout(finish);disconnected();});
 });const url=await listen(upstream);const proxy=createProxyServer(f.g,{upstream:url,apiKey:'key'});const base=await listen(proxy);
 t.after(()=>{proxy.closeAllConnections();proxy.close();upstream.closeAllConnections();upstream.close();f.g.close();});
 const abort=new AbortController();const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${f.g.issueToken(f.id,f.agent.toPublicKey().toString())}`},body:'{}',signal:abort.signal});
 const reader=response.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/first/);assert.doesNotMatch(new TextDecoder().decode(first.value),/last/);
 abort.abort();await Promise.race([closed,new Promise((_,j)=>{const timer=setTimeout(()=>j(Error('upstream not cancelled')),1000);timer.unref();})]);
});
test('redirects never forward keys to another origin and upstream failure is counted',async t=>{
 const f=await fixture();f.g.operations={'POST /v1/chat/completions':1};let leaked=0;
 const sink=httpServer((req,res)=>{leaked++;res.end('leak');});const sinkUrl=await listen(sink);
 const upstream=httpServer((req,res)=>{res.writeHead(307,{location:sinkUrl});res.end();});const url=await listen(upstream);
 const proxy=createProxyServer(f.g,{upstream:url,apiKey:'secret'});const base=await listen(proxy);
 t.after(()=>{for(const s of [proxy,upstream,sink]){s.closeAllConnections();s.close();}f.g.close();});
 const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${f.g.issueToken(f.id,f.agent.toPublicKey().toString())}`},body:'{}'});
 assert.equal(response.status,502);assert.equal(leaked,0);assert.equal(f.g.status(f.id).used,1);assert.doesNotMatch(await response.text(),/secret/);
});
test('body and IP rate limits reject requests before authorization',async t=>{
 const f=await fixture();f.g.operations={'POST /v1/chat/completions':1};
 const proxy=createProxyServer(f.g,{upstream:'http://127.0.0.1:1',apiKey:'secret',rateLimit:1});const base=await listen(proxy);
 t.after(()=>{proxy.closeAllConnections();proxy.close();f.g.close();});
 const headers={authorization:`Bearer ${f.g.issueToken(f.id,f.agent.toPublicKey().toString())}`};
 assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'x'.repeat(65537)})).status,413);
 assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'{}'})).status,429);
 assert.equal(f.g.status(f.id).used,0);
});
test('unavailable upstream returns sanitized 502 and refunds admission',async t=>{
 const f=await fixture();f.g.operations={'POST /v1/chat/completions':1};
 const proxy=createProxyServer(f.g,{upstream:'http://127.0.0.1:1',apiKey:'server-secret'});const base=await listen(proxy);
 t.after(()=>{proxy.closeAllConnections();proxy.close();f.g.close();});
 const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${f.g.issueToken(f.id,f.agent.toPublicKey().toString())}`},body:'{}'});
 assert.equal(res.status,502);assert.doesNotMatch(await res.text(),/server-secret|ECONN|127\.0\.0\.1/);assert.equal(f.g.status(f.id).used,0);
});
test('upstream URL and configuration validation reject credential injection',async()=>{
 const f=await fixture();
 for(const upstream of ['file:///tmp/a','https://user:pass@example.com','https://example.com?q=1','https://example.com#fragment']) assert.throws(()=>createProxyServer(f.g,{upstream,apiKey:'key'}));
 assert.throws(()=>createProxyServer(f.g,{upstream:'https://example.com',apiKey:'x\r\ny'}));
 assert.throws(()=>createProxyServer(f.g,{upstream:'https://example.com',apiKey:'key',rateLimit:0}));f.g.close();
});
test('bearer management API delegates and reclaims within the caller branch only',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {openState}=await import('./cli/state.mjs');const directory=mkdtempSync(join(tmpdir(),'proxy-delegate-'));const state=openState(directory);
 state.issue('root',{n:10,P:1});state.issue('outsider',{n:10});const token=state.token('root');
 const proxy=createProxyServer(state.gateway,{upstream:'http://127.0.0.1:1',apiKey:'test',control:state});const base=await listen(proxy);
 t.after(()=>{proxy.closeAllConnections();proxy.close();state.close();rmSync(directory,{recursive:true,force:true});});
 const send=(path,body,tok=token)=>fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${tok}`},body:JSON.stringify(body)});
 assert.equal((await send('/delegate',{name:'wide',calls:4,scope:3})).status,403);
 assert.equal((await send('/delegate',{name:'stolen',calls:4,parent:'outsider'})).status,403);
 const res=await send('/delegate',{name:'child',calls:4});assert.equal(res.status,200);const child=await res.json();
 assert.equal(state.status('root').remaining,6);assert.equal(state.status('outsider').remaining,10);
 assert.equal((await send('/stop',{},child.token)).status,200);assert.equal(state.status('root').remaining,10);
 assert.equal((await send('/stop',{},child.token)).status,200);assert.equal(state.status('root').remaining,10);
 assert.equal((await send('/delegate',{name:'blocked',calls:1},child.token)).status,403);
});
