import { createServer, request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Denied } from './auth.mjs';

export const OPENAI_OPERATIONS = Object.freeze({
  'POST /v1/chat/completions': 1,
  'POST /v1/embeddings': 2,
  'POST /v1/responses': 4,
  'GET /v1/models': 8,
});

export function createProxyServer(gateway, { upstream, apiKey, rateLimit = 200, timeoutMs = 120000, maxConcurrent = 200, maxConnections = 512, maxUpstreamConnections = 64, control } = {}) {
  if (typeof upstream !== 'string' || /[%\\]/.test(upstream) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(upstream)) throw new Error('invalid upstream path');
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || !Number.isInteger(rateLimit) || rateLimit < 1 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(maxConnections) || maxConnections < 1 ||
      !Number.isInteger(maxUpstreamConnections) || maxUpstreamConnections < 1 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('valid upstream, API key, timeout and rate limit required');
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const Agent = target.protocol === 'https:' ? HttpsAgent : HttpAgent;
  const agent = new Agent({keepAlive:true,maxSockets:maxUpstreamConnections,maxTotalSockets:maxUpstreamConnections,maxFreeSockets:16});
  const clients = new Map();
  let active = 0;
  const server = createServer(async (req, res) => {
    const reply = (status, message) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message } }));
    };
    const ip = req.socket.remoteAddress, now = Date.now();
    for (const [key, item] of clients) if (now - item.start >= 1000) clients.delete(key);
    if (!clients.has(ip)) {
      if (clients.size >= 4096) return reply(429, 'Rate limit');
      clients.set(ip, {start: now, count: 0});
    }
    if (++clients.get(ip).count > rateLimit) return reply(429, 'Rate limit');
    if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); return res.end('{"ok":true}'); }
    if (active >= maxConcurrent) return reply(503, 'At capacity');
    active++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      // Exact paths only: never resolve caller-controlled URLs against the upstream.
      const management = control && req.method === 'POST' && ['/delegate','/stop'].includes(req.url);
      if (!management && !Object.hasOwn(OPENAI_OPERATIONS, `${req.method} ${req.url}`)) return reply(403, 'Request rejected');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return reply(413, 'Body too large');
        chunks.push(chunk);
      }
      const request = { method: req.method, path: req.url, body: Buffer.concat(chunks) };
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
      if (management) {
        if (!bearer) return reply(403, 'Request rejected');
        let body; try { body = JSON.parse(request.body.toString('utf8')); } catch { throw new Denied('invalid JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Denied('invalid body');
        const allowed = req.url === '/delegate' ? ['name','calls','scope','expiresAt'] : [];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new Denied('unknown fields');
        const result = req.url === '/delegate' ? control.delegateToken(bearer[1], body) : control.stopToken(bearer[1]);
        res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
        return res.end(JSON.stringify(result));
      }
      if (req.headers.authorization) {
        if (!bearer) return reply(403, 'Request rejected');
        await gateway.authorizeBearer(bearer[1], request);
      } else {
        await gateway.authorize({ ...request, tranche: req.headers['x-tranche'], agentKey: req.headers['x-agent-key'],
          nonce: req.headers['x-nonce'], signature: req.headers['x-agent-sig'] });
      }
      const result = await new Promise((resolve,reject) => {
        const upstreamRequest = transport(target.href.replace(/\/$/, '') + req.url, {
          method:req.method, agent, signal:abort.signal,
          headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'application/json, text/event-stream'},
        },resolve);
        upstreamRequest.on('error',reject);
        upstreamRequest.end(req.method === 'GET' ? undefined : request.body);
      });
      // Node's HTTP transport does not follow redirects. Never reveal another origin.
      if (result.statusCode >= 300 && result.statusCode < 400) { result.destroy(); return reply(502, 'Upstream redirect rejected'); }
      const headers = { 'cache-control': 'no-store' };
      for (const name of ['content-type', 'x-request-id', 'retry-after']) if (result.headers[name]) headers[name] = result.headers[name];
      res.writeHead(result.statusCode, headers);
      await pipeline(result, res);
    } catch (error) {
      reply(error instanceof Denied ? 403 : 502, error instanceof Denied ? 'Request rejected' : 'Upstream unavailable; authorized calls are counted');
    } finally { clearTimeout(timer); active--; }
  });
  server.once('close',()=>agent.destroy());
  server.maxConnections = maxConnections;
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return server;
}
