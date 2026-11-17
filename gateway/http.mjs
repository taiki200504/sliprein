import { createServer as nodeServer } from 'node:http';
import { Denied, verifySigned } from './auth.mjs';
import { clientKey, validSignedHeaders, closeRequest, readBody } from './transport.mjs';

export function createServer(gateway, { execute, rateLimit = 200, maxConcurrent = 200, maxConnections = 512, bodyTimeoutMs = 5000, trustProxy = false } = {}) {
  if (typeof trustProxy !== 'boolean' || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || typeof execute !== 'function' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(maxConnections) || maxConnections < 1 || !Number.isInteger(rateLimit) || rateLimit < 1) throw new Error('execute and positive rateLimit required');
  const clients = new Map();
  let active = 0;
  const server = nodeServer(async (request, response) => {
    const reply = (status, value, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      response.end(JSON.stringify(value));
    };
    const now = Date.now(); const ip = clientKey(request, trustProxy);
    for (const [key, item] of clients) if (now - item.start >= 1000) clients.delete(key);
    if (!clients.has(ip)) {
      if (clients.size >= 4096) return reply(429, { error: 'rate limit' });
      clients.set(ip, { start: now, count: 0 });
    }
    if (++clients.get(ip).count > rateLimit) return reply(429, { error: 'rate limit' });
    if (request.method === 'GET' && request.url === '/healthz') return reply(200, {ok:true});
    if (!validSignedHeaders(request.headers)) { closeRequest(request,response); return reply(401,{error:'authentication required'}); }
    if (active >= maxConcurrent) return reply(503, {error:'at capacity'});
    active++;
    try {
      const body = await readBody(request,response,bodyTimeoutMs);
      if (body === null || response.writableEnded) return;
      const signed = { tranche: request.headers['x-tranche'], agentKey: request.headers['x-agent-key'], nonce: request.headers['x-nonce'],
        signature: request.headers['x-agent-sig'], method: request.method, path: request.url, body };
      if (signed.path === '/bind' && signed.method === 'POST') {
        verifySigned(signed); gateway.checkAgentRate(signed.agentKey);
        let body; try { body = JSON.parse(signed.body.toString('utf8')); } catch { throw new Denied('invalid JSON'); }
        if (!Array.isArray(body?.ancestors) || body.ancestors.at(-1) !== signed.agentKey) throw new Denied('wrong depositor');
        return reply(200, await gateway.bind(signed.tranche, body.ancestors));
      }
      if (signed.path === '/stop' && signed.method === 'POST') return reply(200, await gateway.stop(signed));
      const authorization = await gateway.authorize(signed);
      let value;
      try { value = await execute(signed); }
      catch { return reply(502, { error: 'service failed; authorized call counted' }); }
      return reply(200, { ...authorization, result: value }, { 'X-Decision-Ms': String(authorization.decisionMs) });
    } catch (error) {
      if (!response.headersSent && !response.writableEnded) reply(error instanceof Denied ? 403 : 503, { error: error instanceof Denied ? 'request rejected' : 'service unavailable' });
    } finally { active--; }
  });
  server.maxConnections = maxConnections;
  server.requestTimeout = bodyTimeoutMs; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  return server;
}
