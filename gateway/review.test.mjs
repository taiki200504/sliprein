import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState } from './cli/state.mjs';
import { createProxyServer } from './proxy.mjs';
const listen = s => new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
async function fixture(t,options={}) {
 const dir=mkdtempSync(join(tmpdir(),'review-'));const state=openState(dir);state.issue('a');const token=state.token('a');
 const proxy=createProxyServer(state.gateway,{upstream:'http://127.0.0.1:1',apiKey:'secret',...options});const base=await listen(proxy);
 t.after(()=>{proxy.closeAllConnections();proxy.close();state.close();rmSync(dir,{recursive:true,force:true});});return {state,token,base,proxy};
}
function raw(base,headers={},body,hold=false) {
 let req;const response=new Promise((resolve,reject)=>{req=request(base+'/v1/chat/completions',{method:'POST',headers},res=>{res.resume();resolve(res);});req.on('error',reject);if(hold)req.flushHeaders();else req.end(body);});
 return {response, get req(){return req;}};
}
test('M1 missing, malformed and unknown authentication is rejected before slow bodies',async t=>{
 const {base,state}=await fixture(t,{maxConcurrent:1,bodyTimeoutMs:40});
 for(const authorization of [undefined,'Bearer bad','Bearer '+'a'.repeat(43)]) {
  const r=raw(base,{'content-length':'100',...(authorization?{authorization}:{})},undefined,true);
  const res=await Promise.race([r.response,new Promise((_,j)=>setTimeout(()=>j(Error('authentication waited for body')),200))]).finally(()=>r.req.destroy());assert.equal(res.statusCode,401);
 }
 assert.equal(state.status('a').used,0);
});
test('M1 body deadline releases authenticated capacity without charging',async t=>{
 const {base,token,state}=await fixture(t,{maxConcurrent:1,bodyTimeoutMs:40});
 const r=raw(base,{authorization:`Bearer ${token}`,'content-length':'100'},undefined,true);
 const res=await Promise.race([r.response,new Promise((_,j)=>setTimeout(()=>j(Error('body deadline missing')),250))]).finally(()=>r.req.destroy());assert.equal(res.statusCode,408);assert.equal(state.status('a').used,0);
});
test('M2 explicit proxy trust uses last hop and collapses IPv6 /64',async t=>{
 const {base}=await fixture(t,{trustProxy:true,rateLimit:2});
 const send=ip=>fetch(base+'/healthz',{headers:{'x-forwarded-for':ip}});
 assert.equal((await send('192.0.2.1, 2001:db8:1:2::1')).status,200);
 assert.equal((await send('192.0.2.2, 2001:0db8:0001:0002:abcd::2')).status,200);
 assert.equal((await send('192.0.2.3, 2001:db8:1:2::ffff')).status,429);
 assert.equal((await send('2001:db8:1:3::1')).status,200);
});
test('M2 forwarded addresses are ignored by default',async t=>{
 const {base}=await fixture(t,{rateLimit:1});
 assert.equal((await fetch(base+'/healthz',{headers:{'x-forwarded-for':'192.0.2.1'}})).status,200);
 assert.equal((await fetch(base+'/healthz',{headers:{'x-forwarded-for':'192.0.2.2'}})).status,429);
});
test('M3 oversized bodies close the socket after delivering 413',async t=>{
 const {base,token}=await fixture(t);const r=raw(base,{authorization:`Bearer ${token}`,'content-length':'100000','connection':'keep-alive'},undefined,true);
 r.req.write('x'.repeat(65537));const res=await r.response;assert.equal(res.statusCode,413);assert.equal(res.headers.connection,'close');
 await new Promise((resolve,reject)=>{if(r.req.socket.destroyed)return resolve();r.req.socket.once('close',resolve);setTimeout(()=>reject(Error('socket not closed')),200).unref();});
});
test('L1 tokens expire and revoke by agent without stopping other agents',async t=>{
 const {state,base,token}=await fixture(t);state.issue('b');const other=state.token('b');
 let now=state.gateway.now();state.gateway.now=()=>now;const expiring=state.token('a',{expiresAt:now+1});now++;
 assert.throws(()=>state.gateway.resolveToken(expiring));state.revokeTokens('a');assert.throws(()=>state.gateway.resolveToken(token));assert.ok(state.gateway.resolveToken(other));
 assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'})).status,401);
 assert.equal(state.status('a').stopped,0);
});
test('L2 connection refusal refunds once while preserving replay protection',async t=>{
 const {state,base,token}=await fixture(t);
 assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'})).status,502);
 assert.equal(state.status('a').used,0);assert.equal(state.status('a').remaining,100);
 const row=state.gateway.db.prepare('SELECT * FROM events').get();assert.equal(row.kind,'refund');
 assert.equal(state.gateway.refund({tranche:row.tranche,nonce:row.nonce}),false);
});
test('L2 timeout before headers refunds; failure after headers remains charged',async t=>{
 const upstream=createServer((req,res)=>{if(req.headers.accept){res.writeHead(200);res.write('partial');setTimeout(()=>res.destroy(),20);}});const url=await listen(upstream);t.after(()=>{upstream.closeAllConnections();upstream.close();});
 const {state,base,token}=await fixture(t,{upstream:url});
 await assert.rejects(async()=>{const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'});await res.text();});assert.equal(state.status('a').used,1);
 const hanging=createServer(()=>{});const hangURL=await listen(hanging);t.after(()=>{hanging.closeAllConnections();hanging.close();});
 const f=await fixture(t,{upstream:hangURL,timeoutMs:30});assert.equal((await fetch(f.base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${f.token}`},body:'{}'})).status,502);assert.equal(f.state.status('a').used,0);
});
test('L1 CLI revocation and expiry survive reopening existing state',async t=>{
 const {spawnSync}=await import('node:child_process');const {state,token}=await fixture(t);const dir=state.gateway.db.location();
 const database=state.gateway.db; // Exercise migration from the original three-column table.
 database.exec('ALTER TABLE agent_tokens DROP COLUMN revoked; ALTER TABLE agent_tokens DROP COLUMN expires');
 const path=join(dir,'..');
 const run=args=>spawnSync(process.execPath,['gateway/cli/main.mjs',...args,'--state',path],{encoding:'utf8'});
 const expiry=run(['token','a','--ttl','10']);assert.equal(expiry.status,0,expiry.stderr);assert.match(expiry.stdout.trim(),/^[\w-]{43}$/);
 state.issue('revoke');assert.equal(run(['token','revoke']).status,0);
 const revoke=run(['token','revoke','a']);assert.equal(revoke.status,0,revoke.stderr);assert.ok(JSON.parse(revoke.stdout).revoked>=2);
 const reopened=openState(path);t.after(()=>reopened.close());assert.throws(()=>reopened.gateway.resolveToken(token));assert.throws(()=>reopened.gateway.resolveToken(expiry.stdout.trim()));
 assert.equal(run(['token','a','--ttl','999999']).status,1);
});
test('L2 refund during subtree stop preserves total quota and pending settlement',async t=>{
 const {state}=await fixture(t);state.delegate('a','child',10);const token=state.token('child');
 const auth=await state.gateway.authorizeBearer(token,{method:'POST',path:'/v1/chat/completions',body:'{}'});state.gateway.trackUpstream(auth.receipt);
 state.stop('child');await assert.rejects(state.gateway.settle(auth.receipt.tranche),/pending/);
 assert.equal(state.gateway.refund(auth.receipt),true);assert.equal(state.status('a').remaining,100);assert.equal(state.status('child').used,0);assert.equal(state.status('child').remaining,0);assert.deepEqual(state.gateway.pendingSettlements(),[]);
});
test('M1/M3 signed server preflights headers, enforces body deadline and closes oversized requests',async t=>{
 const {createServer: signedServer}=await import('./http.mjs');
 const proxy=signedServer({}, {execute:()=>{},bodyTimeoutMs:30,maxConcurrent:1});const base=await listen(proxy);t.after(()=>{proxy.closeAllConnections();proxy.close();});
 const headers={'x-tranche':'a'.repeat(64)+':0','x-agent-key':'02'+'a'.repeat(64),'x-nonce':'test','x-agent-sig':'ab'.repeat(32)};
 const missing=raw(base,{'content-length':'100'},undefined,true);assert.equal((await missing.response).statusCode,401);missing.req.destroy();
 const slow=raw(base,{...headers,'content-length':'100'},undefined,true);assert.equal((await slow.response).statusCode,408);slow.req.destroy();
 const big=raw(base,{...headers,'content-length':'100000','connection':'keep-alive'},undefined,true);big.req.write('x'.repeat(65537));const res=await big.response;assert.equal(res.statusCode,413);assert.equal(res.headers.connection,'close');big.req.destroy();
});
test('M2 canonical IP keys normalize direct IPv6 and mapped IPv4; invalid last hop is untrusted',async()=>{
 const {clientKey}=await import('./transport.mjs');const req=(ip,forward)=>({socket:{remoteAddress:ip},headers:{'x-forwarded-for':forward}});
 assert.equal(clientKey(req('2001:db8::1234')),clientKey(req('2001:0db8:0:0:abcd::1')));
 assert.notEqual(clientKey(req('2001:db8:0:1::1')),clientKey(req('2001:db8:0:2::1')));
 assert.equal(clientKey(req('::ffff:192.0.2.1')),'192.0.2.1');
 assert.equal(clientKey(req('fe80::1%lo0')),'fe80:0:0:0::/64');
 assert.equal(clientKey(req('127.0.0.1','192.0.2.1, invalid'),true),'127.0.0.1');
});
test('L1 revocation is checked again after reading a slow body',async t=>{
 const {state,base,token}=await fixture(t);const r=raw(base,{authorization:`Bearer ${token}`,'content-length':'2'},undefined,true);
 await new Promise(r=>setTimeout(r,10));state.revokeTokens('a');r.req.end('{}');const res=await r.response;assert.ok([401,403].includes(res.statusCode));assert.equal(state.status('a').used,0);
});
