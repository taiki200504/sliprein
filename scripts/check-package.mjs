// Run under the shared heavy lock: install into a disposable directory, never the shared checkout.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
const directory=mkdtempSync(join(tmpdir(),'package-quickstart-'));
const root=new URL('../',import.meta.url).pathname;
const run=(cmd,args,cwd=directory)=>{
 const result=spawnSync(cmd,args,{cwd,encoding:'utf8',env:{...process.env,npm_config_cache:join(directory,'cache')}});
 if(result.status!==0)throw Error(`${cmd} failed: ${result.stderr}`);return result.stdout;
};
let child;const mock=createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer fresh-mock-key');for await(const c of req){}res.setHeader('content-type','application/json');res.end('{"choices":[]}');});
try {
 const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',directory],root))[0];
 const files=packed.files.map(x=>x.path);assert.ok(!files.some(x=>/AI_WORKLOG|\.sqlite|\.key$|\.test\.mjs$/.test(x)));
 run('npm',['init','-y']);run('npm',['install','--ignore-scripts',join(directory,packed.filename)]);
 const cli=['exec','--offline','--','sliprein'];const state=join(directory,'state');
 assert.match(run('npm',[...cli,'issue','agent-1','--calls','100','--state',state]),/remaining/);
 assert.ok(!readFileSync(join(directory,'package-lock.json'),'utf8').includes('@bsv/sdk'),'default install must not contain BSV SDK');
 const token=run('npm',[...cli,'token','agent-1','--state',state]).trim();assert.match(token,/^[\w-]{43}$/);
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 // Reserve a free port without assuming one is available on the shared host.
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 child=spawn(process.execPath,[join(directory,'node_modules/.bin/sliprein'),'serve','--upstream',`http://127.0.0.1:${mock.address().port}`,'--state',state,'--port',String(port)],{cwd:directory,env:{...process.env,UPSTREAM_API_KEY:'fresh-mock-key'},stdio:['ignore','pipe','pipe']});
 let ready=false;child.stdout.on('data',()=>ready=true);
 for(let i=0;i<100&&!ready;i++){if(child.exitCode!==null)throw Error('serve exited');await sleep(25);}
 assert.ok(ready,'serve starts in a clean install');
 const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{choices:[]});
 run('npm',[...cli,'stop','agent-1','--state',state]);
 assert.equal((await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'})).status,403);
 // Verify the exact checkout Quickstart command with an independent private store.
 const local=spawnSync('npm',['run','-s','sliprein','--','issue','quickstart-check','--state',join(directory,'checkout-state')],{cwd:root,encoding:'utf8'});
 assert.equal(local.status,0,local.stderr);assert.match(local.stdout,/remaining/);
 const gatewayPacked=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',directory],join(root,'gateway')))[0];
 const gatewayDirectory=join(directory,'gateway-project');
 (await import('node:fs')).mkdirSync(gatewayDirectory);run('npm',['init','-y'],gatewayDirectory);
 run('npm',['install','--ignore-scripts',join(directory,gatewayPacked.filename)],gatewayDirectory);
 assert.ok(!readFileSync(join(gatewayDirectory,'package-lock.json'),'utf8').includes('@bsv/sdk'));
 assert.match(run('npm',[...cli,'issue','gateway-agent','--state',join(directory,'gateway-state')],gatewayDirectory),/remaining/);
 console.log(JSON.stringify({gatewayStandalone:'passed',bsvDependency:'absent',cleanInstall:'passed',quickstart:'passed',authenticatedProxy:200,afterStop:403,packageFiles:files.length}));
}finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
 mock.closeAllConnections();await new Promise(r=>mock.close(r));rmSync(directory,{recursive:true,force:true});
}
