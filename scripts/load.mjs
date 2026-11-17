// Zero runtime dependencies. Local mock only; never sends provider credentials.
import { createServer, request, Agent } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import { openState } from '../gateway/cli/state.mjs';
import { createProxyServer } from '../gateway/proxy.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const samples=Number(process.env.LOAD_SAMPLES??1000);
const limits=process.env.LOAD_DEFAULTS==='1';
if(!Number.isSafeInteger(samples)||samples<200||samples>100000)throw Error('LOAD_SAMPLES must be 200..100000');
console.log(JSON.stringify({node:process.version,platform:platform(),release:release(),cpu:cpus()[0].model,cpus:cpus().length,memoryGiB:totalmem()/2**30,samples,mode:limits?'default-limits':'capacity (rate limits raised explicitly)',storage:'temporary local disk, WAL, synchronous=FULL',mock:'JSON, 5ms delay, 1KiB response',warmup:'one request per client, connection ramp in batches of 25'}));
for(const concurrency of [50,200]) {
 const dir=mkdtempSync(join(tmpdir(),'sliprein-load-'));const state=openState(dir);
 const upstream=createServer(async(req,res)=>{for await(const chunk of req){}setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:'x'.repeat(1024)}));},5);});
 let proxy;const agents=Array.from({length:concurrency},()=>new Agent({keepAlive:true,maxSockets:1}));
 try {
  state.issue('load',{n:samples+concurrency+50,P:1});const token=state.token('load');
  if(!limits)state.gateway.agentRateLimit=1000000;
  await listen(upstream);proxy=createProxyServer(state.gateway,{upstream:`http://127.0.0.1:${upstream.address().port}`,apiKey:'mock-only',...(limits?{}:{rateLimit:1000000})});await listen(proxy);
  const send=agent=>new Promise(resolve=>{const start=performance.now();const req=request({host:'127.0.0.1',port:proxy.address().port,path:'/v1/chat/completions',method:'POST',agent,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve({ms:performance.now()-start,status:res.statusCode}));res.on('error',error=>resolve({ms:performance.now()-start,status:0,error:'response:'+error.code}));});req.on('error',error=>resolve({ms:performance.now()-start,status:0,error:error.code}));req.setTimeout(10000,()=>req.destroy());req.end('{}');});
  for(let i=0;i<concurrency;i+=25)await Promise.all(agents.slice(i,i+25).map(send));
  // Do not let warmup consume a default-limit window.
  await new Promise(r=>setTimeout(r,1050));
  let next=0;const results=[];const start=performance.now();
  await Promise.all(agents.map(async agent=>{while(next++<samples)results.push(await send(agent));}));
  const seconds=(performance.now()-start)/1000,latencies=results.map(x=>x.ms).sort((a,b)=>a-b),statuses={};
  for(const row of results)statuses[row.status]=(statuses[row.status]??0)+1;
  const errors={};for(const row of results)if(row.error)errors[row.error]=(errors[row.error]??0)+1;
  const successes=results.filter(x=>x.status===200).length;
  console.log(JSON.stringify({concurrency,samples,seconds,rps:results.length/seconds,successfulRps:successes/seconds,p50Ms:latencies[Math.floor(latencies.length*.5)],p99Ms:latencies[Math.min(latencies.length-1,Math.floor(latencies.length*.99))],errorRate:(results.length-successes)/results.length,statuses,errors}));
 } finally {
  for(const agent of agents)agent.destroy();for(const s of [proxy,upstream])if(s){s.closeAllConnections();await new Promise(r=>s.close(r));}state.close();rmSync(dir,{recursive:true,force:true});
 }
}
