import { isIP } from 'node:net';

// Only enable trustProxy behind a proxy that overwrites/appends the real client hop.
export function clientKey(req, trustProxy = false) {
  let ip = req.socket.remoteAddress;
  if (trustProxy && typeof req.headers['x-forwarded-for'] === 'string') {
    const last = req.headers['x-forwarded-for'].split(',').at(-1).trim();
    if (isIP(last)) ip = last;
  }
  if (isIP(ip) !== 6) return ip;
  let address = new URL(`http://[${ip.split('%')[0]}]/`).hostname.slice(1,-1);
  if (address.startsWith('::ffff:')) {
    const parts = address.slice(7).split(':');
    if (parts.length === 2) { const n = parseInt(parts[0],16)*65536+parseInt(parts[1],16); return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.'); }
  }
  const [left,right] = address.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const groups = right === undefined ? a : [...a,...Array(8-a.length-b.length).fill('0'),...b];
  return groups.slice(0,4).map(v=>parseInt(v,16).toString(16)).join(':')+'::/64';
}
export function validSignedHeaders(headers) {
  return /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/.test(headers['x-tranche'] ?? '') &&
    /^(02|03)[0-9a-f]{64}$/.test(headers['x-agent-key'] ?? '') &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(headers['x-nonce'] ?? '') &&
    /^(?:[0-9a-f]{2}){8,72}$/.test(headers['x-agent-sig'] ?? '');
}
export function closeRequest(req, res) {
  res.setHeader('Connection','close');
  res.once('finish',()=>req.destroy());
}
export async function readBody(req, res, timeoutMs) {
  const timer = setTimeout(()=>{closeRequest(req,res);res.writeHead(408,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:'body timeout'}));},timeoutMs);
  try {
    const chunks=[];let size=0;
    for await (const chunk of req) {
      size+=chunk.length;
      if (size>65536) {closeRequest(req,res);res.writeHead(413,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:'body too large'}));return null;}
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {clearTimeout(timer);}
}
