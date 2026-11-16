import { generateKeyPairSync, sign, verify, createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const GRANT=['approvalId','tenant','actor','tool','resource','argsDigest','expiresAt','nonce','policyVersion'];
const RESULT=['approvalDigest','approvalId','tenant','actor','tool','resource','argsDigest','nonce','policyVersion','expectedRevision','revision','status'];
const check=ok=>{if(!ok) throw new Error('Operation rejected');};
function exact(x,keys) {
 check(x!==null && typeof x==='object' && Object.getPrototypeOf(x)===Object.prototype);
 check(Reflect.ownKeys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k)));
 for(const d of Object.values(Object.getOwnPropertyDescriptors(x))) check('value' in d && d.enumerable);
}
// Only flat, validated JSON objects; deliberately not RFC 8785.
const bytes=x=>Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]]))));
const hash=x=>createHash('sha256').update(bytes(x)).digest('hex');
const token=x=>check(typeof x==='string' && x.length>0 && x.length<=128 && /^[A-Za-z0-9:._-]+$/.test(x));
const integer=x=>check(Number.isSafeInteger(x) && x>=1);
function argsSchema(a) {
 exact(a,['expectedRevision','status']);integer(a.expectedRevision);
 check(a.status==='draft'||a.status==='reviewed');
}
function grantSchema(a) {
 exact(a,GRANT);for(const k of GRANT.filter(k=>k!=='expiresAt')) token(a[k]);
 check(/^[a-f0-9]{64}$/.test(a.argsDigest));integer(a.expiresAt);
}
function valid(x,s,key) {
 if(typeof s!=='string'||s.length!==88||!/^[A-Za-z0-9+/]{86}==$/.test(s)) return false;
 const b=Buffer.from(s,'base64');
 if(b.length!==64||b.toString('base64')!==s) return false;
 try{return verify(null,bytes(x),key,b);}catch{return false;}
}
function validateBundle(b,key) {
 exact(b,['approval','signature']);grantSchema(b.approval);
 check(valid(b.approval,b.signature,key));
}
export function execute(bundle,args,env) {
 validateBundle(bundle,env.approvalPublicKey);argsSchema(args);
 const a=bundle.approval;
 check(hash(args)===a.argsDigest);
 exact(env.context,['tenant','actor','tool','resource']);
 for(const k of ['tenant','actor','tool','resource']) check(a[k]===env.context[k]);
 check(a.tool==='record.patch' && env.allowedTools.has(a.tool) && a.policyVersion===env.policyVersion);
 check(Number.isSafeInteger(env.now)&&env.now>=0&&a.expiresAt>env.now&&a.expiresAt-env.now<=300000);
 check(!env.revoked.has(a.approvalId)&&!env.consumed.has(a.approvalId));
 exact(env.state,['record']);const record=env.state.record;
 exact(record,['tenant','id','status','revision']);token(record.tenant);token(record.id);integer(record.revision);
 check(record.status==='draft'||record.status==='reviewed');
 check(record.tenant===a.tenant&&'record:'+record.id===a.resource&&record.revision===args.expectedRevision);
 const revision=record.revision+1;integer(revision);
 const result={approvalDigest:hash(a),approvalId:a.approvalId,tenant:a.tenant,actor:a.actor,tool:a.tool,resource:a.resource,argsDigest:a.argsDigest,nonce:a.nonce,policyVersion:a.policyVersion,expectedRevision:args.expectedRevision,revision,status:args.status};
 // Signing can fail: finish it before changing either memory state.
 const signature=sign(null,bytes(result),env.resultPrivateKey).toString('base64');
 const nextState={record:{...record,status:args.status,revision}};
 env.consumed.add(a.approvalId);env.state=nextState;
 return {result,signature};
}
export function verifyReceipt(receipt,expectedApproval,trust) {
 try {
  validateBundle(expectedApproval,trust.approvalPublicKey);
  exact(receipt,['result','signature']);const r=receipt.result;exact(r,RESULT);
  const a=expectedApproval.approval;
  check(r.approvalDigest===hash(a));
  for(const k of ['approvalId','tenant','actor','tool','resource','argsDigest','nonce','policyVersion']) check(r[k]===a[k]);
  argsSchema({expectedRevision:r.expectedRevision,status:r.status});integer(r.revision);
  check(r.tool==='record.patch'&&r.revision===r.expectedRevision+1);
  check(hash({expectedRevision:r.expectedRevision,status:r.status})===a.argsDigest);
  return valid(r,receipt.signature,trust.resultPublicKey);
 }catch{return false;}
}
export function fixture() {
 const signing=generateKeyPairSync('ed25519'),resultSigning=generateKeyPairSync('ed25519');
 const context={tenant:'fictional-team',actor:'fictional-ai',tool:'record.patch',resource:'record:demo'};
 const args={expectedRevision:1,status:'reviewed'},now=Date.now();
 const approval={approvalId:randomUUID(),...context,argsDigest:hash(args),expiresAt:now+60000,nonce:randomUUID(),policyVersion:'v1'};
 const issue=(overrides={})=>{const a={...approval,...overrides};return {approval:a,signature:sign(null,bytes(a),signing.privateKey).toString('base64')};};
 const trust={approvalPublicKey:signing.publicKey,resultPublicKey:resultSigning.publicKey};
 const env={...trust,context,now,allowedTools:new Set(['record.patch']),policyVersion:'v1',revoked:new Set(),consumed:new Set(),resultPrivateKey:resultSigning.privateKey,state:{record:{tenant:context.tenant,id:'demo',status:'draft',revision:1}}};
 return {args,bundle:issue(),env,trust,issue};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 const f=fixture(),receipt=execute(f.bundle,f.args,f.env);
 check(verifyReceipt(receipt,f.bundle,f.trust));
 console.log(JSON.stringify({event:'record.updated',state:f.env.state,receiptVerified:true}));
 const tampered=structuredClone(receipt);tampered.result.status='draft';
 check(!verifyReceipt(tampered,f.bundle,f.trust));
 console.log(JSON.stringify({event:'tampering',rejected:true}));
 let rejected=false;try{execute(f.bundle,f.args,f.env);}catch{rejected=true;}
 check(rejected&&f.env.state.record.revision===2);
 console.log(JSON.stringify({event:'replay',rejected,state:f.env.state}));
}
