import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Denied } from './auth.mjs';

export const OPENAI_OPERATIONS = Object.freeze({
  'POST /v1/chat/completions': 1,
  'POST /v1/embeddings': 2,
  'POST /v1/responses': 4,
  'GET /v1/models': 8,
});

export function createProxyServer(gateway, { upstream, apiKey, rateLimit = 200, timeoutMs = 120000, control } = {}) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || !Number.isInteger(rateLimit) || rateLimit < 1 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('valid upstream, API key, timeout and rate limit required');
  const clients = new Map();
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
      const result = await fetch(target.href.replace(/\/$/, '') + req.url, {
        method: req.method, body: req.method === 'GET' ? undefined : request.body,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        redirect: 'manual', signal: abort.signal,
      });
      // Redirects may expose credentials or cause the SDK to bypass the gate.
      if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); return reply(502, 'Upstream redirect rejected'); }
      const headers = { 'cache-control': 'no-store' };
      for (const name of ['content-type', 'x-request-id', 'retry-after']) if (result.headers.has(name)) headers[name] = result.headers.get(name);
      res.writeHead(result.status, headers);
      if (result.body) await pipeline(Readable.fromWeb(result.body), res); else res.end();
    } catch (error) {
      reply(error instanceof Denied ? 403 : 502, error instanceof Denied ? 'Request rejected' : 'Upstream unavailable; authorized calls are counted');
    } finally { clearTimeout(timer); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  return server;
}
