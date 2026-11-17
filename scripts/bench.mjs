// Admission includes durable SQLite accounting; E2E includes local HTTP, auth, mock upstream and body consumption.
import { createServer } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir,cpus,totalmem,platform,arch,release } from 'node:os';
import { join } from 'node:path';
import { openState } from '../gateway/cli/state.mjs';
import { createProxyServer } from '../gateway/proxy.mjs';
const samples=Number(process.env.BENCH_SAMPLES??500),concurrency=Number(process.env.BENCH_CONCURRENCY??1);
if(!Number.isInteger(samples)||samples<1||samples>100000||!Number.isInteger(concurrency)||concurrency<1||concurrency>32)throw Error('invalid benchmark parameters');
const directory=mkdtempSync(join(tmpdir(),'proxy-benchmark-'));const state=openState(directory);
const mock=createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');res.end('{"choices":[]}');});
let proxy;
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const stats=a=>{a.sort((a,b)=>a-b);return{samples:a.length,p50Ms:a[Math.ceil(a.length*.5)-1],p99Ms:a[Math.ceil(a.length*.99)-1]};};
async function measure(fn,n){const values=[];let next=0;await Promise.all(Array.from({length:concurrency},async()=>{while(next++<n){const t=performance.now();await fn();values.push(performance.now()-t);}}));return stats(values);}
try {
 state.gateway.agentRateLimit=1000000; // Capacity benchmark explicitly raises admission limits.
 state.issue('admission',{n:samples+50});state.issue('proxy',{n:samples+50});
 const direct=state.token('admission'),token=state.token('proxy');
 const authorize=()=>state.gateway.authorizeBearer(direct,{method:'POST',path:'/v1/chat/completions',body:'{}'});
 await listen(mock);proxy=createProxyServer(state.gateway,{upstream:`http://127.0.0.1:${mock.address().port}`,apiKey:'mock-only',rateLimit:100000});await listen(proxy);
 const call=async()=>{const res=await fetch(`http://127.0.0.1:${proxy.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'});await res.text();if(res.status!==200)throw Error('benchmark call rejected');};
 for(let i=0;i<50;i++){await authorize();await call();}
 const admission=await measure(authorize,samples),endToEnd=await measure(call,samples);
 console.log(JSON.stringify({node:process.version,machine:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:totalmem()/2**30},concurrency,agentRateLimit:1000000,warmup:50,storage:'SQLite WAL synchronous=FULL, local temporary disk',transport:'loopback HTTP, mock JSON upstream, no provider network',admission,endToEnd},null,2));
}finally{for(const s of [proxy,mock])if(s){s.closeAllConnections();await new Promise(r=>s.close(r));}state.close();rmSync(directory,{recursive:true,force:true});}
