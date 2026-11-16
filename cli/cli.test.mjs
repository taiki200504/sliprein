import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openState } from '../gateway/cli/state.mjs';
const cli = new URL('../gateway/cli/main.mjs',import.meta.url);
test('CLI persistent issue, delegate, token, stop, status and quota conservation', async t=>{
 const directory=mkdtempSync(join(tmpdir(),'agent-cli-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const run=(...args)=>spawnSync(process.execPath,[cli.pathname,...args,'--state',directory],{encoding:'utf8'});
 let out=run('issue','parent','--calls','10');assert.equal(out.status,0,out.stderr);
 assert.equal(run('issue','sibling','--calls','4').status,0);
 assert.equal(run('delegate','parent','child','--calls','3').status,0);
 assert.equal(run('delegate','parent','overflow','--calls','8').status,1);
 assert.equal(JSON.parse(run('status','parent').stdout).remaining,7);
 assert.equal(run('issue','parent').status,1);
 const token=run('token','child').stdout.trim();assert.match(token,/^[A-Za-z0-9_-]{43}$/);
 const state=openState(directory);await state.gateway.authorizeBearer(token,{method:'POST',path:'/v1/chat/completions',body:'{}'});state.close();
 assert.equal(run('stop','parent').status,0);
 assert.equal(JSON.parse(run('status','child').stdout).stopped,1);
 assert.equal(JSON.parse(run('status','sibling').stdout).stopped,0);
 assert.equal(run('token','child').status,1);
 assert.equal(run('issue','bad','--calls','NaN').status,1);
 assert.equal(run('serve','--upstream','file:///tmp/x').status,1);
});
test('CLI delegation rollback and scope expiry checks',()=>{
 const directory=mkdtempSync(join(tmpdir(),'agent-state-'));const s=openState(directory);
 try {
  s.issue('parent',{n:5,P:1});s.issue('exists');
  assert.throws(()=>s.delegate('parent','exists',3));assert.equal(s.status('parent').remaining,5);
  assert.throws(()=>s.delegate('parent','negative',-1));
  s.stop('parent');assert.throws(()=>s.delegate('parent','late',1));
 }finally{s.close();rmSync(directory,{recursive:true,force:true});}
});
test('state refuses public directories and failed issuance leaves no partial agent',()=>{
 const directory=mkdtempSync(join(tmpdir(),'agent-permissions-'));
 chmodSync(directory,0o755);assert.throws(()=>openState(directory));chmodSync(directory,0o700);
 const s=openState(directory);
 try {
  assert.throws(()=>s.issue('invalid',{n:-1}));assert.deepEqual(s.status(),[]);
  s.issue('valid',{n:2});const token=s.token('valid');
  s.close();const reopened=openState(directory);assert.equal(reopened.status('valid').remaining,2);reopened.close();
  assert.match(token,/^[\w-]{43}$/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('stopping a delegated subtree returns every unused call exactly once',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'budget-return-'));const s=openState(directory);
 try {
  s.issue('root',{n:20,P:3});s.delegate('root','branch',10);s.delegate('branch','leaf',4);s.delegate('root','sibling',3);
  const token=s.token('leaf');await s.gateway.authorizeBearer(token,{method:'POST',path:'/v1/chat/completions',body:'{}'});
  s.stop('branch');assert.equal(s.status('root').remaining,16);assert.equal(s.status('branch').remaining,0);assert.equal(s.status('leaf').remaining,0);
  assert.equal(s.status('sibling').remaining,3);s.stop('branch');s.stop('leaf');assert.equal(s.status('root').remaining,16);
 } finally{s.close();rmSync(directory,{recursive:true,force:true});}
});
test('agent token delegation conserves budget and cannot widen scope or expiry',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'agent-split-'));const s=openState(directory);
 try {
  const T=Math.floor(Date.now()/1000)+300;s.issue('root',{n:10,P:1,T});const token=s.token('root');
  assert.throws(()=>s.delegateToken(token,{name:'wide',calls:3,scope:3}));
  assert.throws(()=>s.delegateToken(token,{name:'late',calls:3,expiresAt:T+1}));
  const child=s.delegateToken(token,{name:'child',calls:4});assert.equal(s.status('root').remaining,6);
  assert.equal((await s.gateway.authorizeBearer(child.token,{method:'POST',path:'/v1/chat/completions',body:'{}'})).remaining,3);
  await assert.rejects(s.gateway.authorizeBearer(child.token,{method:'POST',path:'/v1/embeddings',body:'{}'}));
  s.stopToken(child.token);assert.equal(s.status('root').remaining,9);
  assert.throws(()=>s.delegateToken(child.token,{name:'replay',calls:1}));
 }finally{s.close();rmSync(directory,{recursive:true,force:true});}
});
