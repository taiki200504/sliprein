import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { requireThat, validateID, keyObject, publicKey, ancestryRoot, verifySigned, signingPayload } from './auth.mjs';
import { MemoryLedger, SqliteLedger, openDatabase } from './ledger.mjs';
export { Denied, publicKey, sign, signingPayload, verifySigned } from './auth.mjs';
export { MemoryLedger, SqliteLedger } from './ledger.mjs';
export { createServer } from './http.mjs';

export class Gateway {
  constructor({ key, ledger, filename = ':memory:', operations, agentRateLimit = 100, now = () => Math.floor(Date.now() / 1000) }) {
    requireThat(Number.isInteger(agentRateLimit) && agentRateLimit > 0, 'invalid agent rate limit');
    this.agentRateLimit = agentRateLimit; this.agentWindows = new Map(); this.lastPrune = 0;
    this.statements = new Map();
    this.key = key; this.holder = publicKey(key); this.now = now;
    this.db = openDatabase(filename);
    this.ownsLedger = !ledger;
    this.ledger = ledger ?? (filename === ':memory:' ? new MemoryLedger() : new SqliteLedger({ db: this.db }));
    requireThat(['readTranche', 'isSpent', 'settle'].every(method => typeof this.ledger[method] === 'function'), 'Ledger interface required');
    requireThat(operations && Object.keys(operations).length > 0, 'operation map required');
    this.operations = Object.freeze(Object.fromEntries(Object.entries(operations).map(([route, bit]) => {
      requireThat(Number.isInteger(bit) && bit > 0 && bit <= 0x40000000 && Number.isInteger(Math.log2(bit)), 'operation must be one bit');
      return [route.includes(' ') ? route : `POST ${route}`, bit];
    })));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS agent_tokens (digest TEXT PRIMARY KEY, tranche TEXT NOT NULL, agent_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tranches (
        id TEXT PRIMARY KEY, ancestors TEXT NOT NULL, agent_key TEXT NOT NULL,
        n INTEGER NOT NULL, remaining INTEGER NOT NULL CHECK(remaining>=0), used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
        P INTEGER NOT NULL, T INTEGER NOT NULL, stopped INTEGER NOT NULL DEFAULT 0, reason TEXT,
        CHECK(n=remaining+used));
      CREATE TABLE IF NOT EXISTS events (
        tranche TEXT NOT NULL, nonce TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        signature TEXT NOT NULL, agent_key TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(tranche,nonce));
      CREATE TABLE IF NOT EXISTS settlements (tranche TEXT PRIMARY KEY, k INTEGER NOT NULL CHECK(k>0), status TEXT NOT NULL DEFAULT 'pending', result TEXT);
      CREATE INDEX IF NOT EXISTS tranches_expiry ON tranches(T);
      CREATE INDEX IF NOT EXISTS tranches_active ON tranches(stopped,id);
      CREATE INDEX IF NOT EXISTS events_receipts ON events(tranche,kind);`);
    const columns = this.db.prepare('PRAGMA table_info(agent_tokens)').all().map(row=>row.name);
    if (!columns.includes('revoked')) this.db.exec('ALTER TABLE agent_tokens ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('expires')) this.db.exec('ALTER TABLE agent_tokens ADD COLUMN expires INTEGER');
    this.pendingUpstream = new Set();
  }
  prepare(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  close() { if (!this.closed) { this.closed = true; if (this.ownsLedger) this.ledger.close(); this.db.close(); } }
  pruneEvents() {
    // Only expired authority can lose replay history. Bound work per maintenance tick.
    return this.prepare(`DELETE FROM events WHERE rowid IN (
      SELECT events.rowid FROM tranches JOIN events ON events.tranche=tranches.id
      WHERE tranches.T < ? LIMIT 1000)`).run(this.now() - 86400).changes;
  }
  checkAgentRate(key) {
    const now = Date.now();
    if (now - this.lastPrune >= 1000) {
      for (const [id, item] of this.agentWindows) if (now - item.start >= 1000) this.agentWindows.delete(id);
      this.lastPrune = now;
    }
    let window = this.agentWindows.get(key);
    if (!window || now - window.start >= 1000) {
      requireThat(this.agentWindows.size < 10000 || window, 'agent rate limit');
      this.agentWindows.set(key, window = {start:now,count:0});
    }
    requireThat(++window.count <= this.agentRateLimit, 'agent rate limit');
  }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(id) { validateID(id); const r = this.prepare('SELECT * FROM tranches WHERE id=?').get(id); requireThat(r, 'unknown tranche'); return r; }
  status(id) { const r = this.row(id); return { remaining: r.remaining, used: r.used, stopped: r.stopped }; }
  receipts(id) { this.row(id); return this.prepare("SELECT nonce,payload,signature,agent_key,created_at FROM events WHERE tranche=? AND kind='use' ORDER BY rowid").all(id); }
  async bind(id, ancestors) {
    validateID(id);
    requireThat(Array.isArray(ancestors) && ancestors.length >= 1 && ancestors.length <= 8, 'invalid ancestry');
    ancestors = [...ancestors];
    for (const key of ancestors) { try { keyObject(key); } catch { throw new Denied('invalid ancestor key'); } }
    requireThat(await this.ledger.isSpent(id) === false, 'spent or unavailable');
    const s = await this.ledger.readTranche(id);
    requireThat(s && s.id === id && s.holder === this.holder && (s.phase ?? 0) === 0 && s.T >= this.now(), 'wrong holder, phase or expiry');
    for (const field of ['n', 'P', 'T', 'd']) requireThat(Number.isSafeInteger(s[field]) && s[field] >= 0 && s[field] <= 0x7fffffff, 'invalid tranche state');
    requireThat(s.d === ancestors.length && ancestryRoot(ancestors) === s.R, 'ancestry does not match R');
    return this.atomic(() => {
      requireThat(!this.prepare('SELECT 1 FROM tranches WHERE id=?').get(id), 'already bound');
      this.prepare('INSERT INTO tranches(id,ancestors,agent_key,n,remaining,P,T) VALUES(?,?,?,?,?,?,?)')
        .run(id, JSON.stringify(ancestors), ancestors.at(-1), s.n, s.n, s.P, s.T);
      return this.status(id);
    });
  }
  async checkLedger(id) {
    validateID(id);
    const spent = await this.ledger.isSpent(id);
    if (spent === true) this.prepare("UPDATE tranches SET stopped=1,reason='ledger-spent' WHERE id=?").run(id);
    requireThat(spent === false, 'spent or unavailable');
  }
  async monitor() {
    const rows = this.prepare('SELECT id FROM tranches WHERE stopped=0').all();
    for (const { id } of rows) {
      const spent = await this.ledger.isSpent(id);
      requireThat(typeof spent === 'boolean', 'ledger unavailable');
      if (spent) this.prepare("UPDATE tranches SET stopped=1,reason='ledger-spent' WHERE id=?").run(id);
    }
  }
  record(request, kind, payload) {
    requireThat(!this.prepare('SELECT 1 FROM events WHERE tranche=? AND nonce=?').get(request.tranche, request.nonce), 'nonce replay');
    this.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(request.tranche, request.nonce, kind, payload, request.signature, request.agentKey, this.now());
  }
  async authorize(request) {
    request = { ...request, body: Buffer.isBuffer(request.body) ? Buffer.from(request.body) : request.body };
    const started = performance.now();
    const payload = verifySigned(request);
    return this.authorizeChecked(request, payload, started);
  }
  issueToken(tranche, agentKey, { expiresAt } = {}) {
    const row = this.row(tranche);
    requireThat(row.agent_key === agentKey && !row.stopped && row.T >= this.now(), 'wrong or inactive agent');
    requireThat(expiresAt === undefined || (Number.isSafeInteger(expiresAt) && expiresAt > this.now() && expiresAt <= row.T), 'invalid token expiry');
    const token = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(token).digest('hex');
    this.prepare('INSERT INTO agent_tokens(digest,tranche,agent_key,expires) VALUES(?,?,?,?)').run(digest, tranche, agentKey, expiresAt ?? null);
    return token;
  }
  resolveToken(token) {
    requireThat(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'invalid token');
    const digest = createHash('sha256').update(token).digest('hex');
    const binding = this.prepare('SELECT * FROM agent_tokens WHERE digest=?').get(digest);
    const stored = binding ? Buffer.from(binding.digest, 'hex') : Buffer.alloc(32);
    requireThat(timingSafeEqual(Buffer.from(digest, 'hex'), stored) && binding, 'unknown token');
    requireThat(!binding.revoked && (binding.expires === null || binding.expires > this.now()), 'inactive token');
    return binding;
  }
  revokeTokens(tranche) { this.row(tranche); return this.prepare('UPDATE agent_tokens SET revoked=1 WHERE tranche=? AND revoked=0').run(tranche).changes; }
  async authorizeBearer(token, request) {
    const binding = this.resolveToken(token);
    request = { ...request, tranche: binding.tranche, agentKey: binding.agent_key, nonce: randomUUID(), signature: 'bearer:' + binding.digest };
    const payload = signingPayload(request);
    return this.authorizeChecked(request, payload, performance.now());
  }
  async authorizeChecked(request, payload, started) {
    this.checkAgentRate(request.agentKey);
    await this.checkLedger(request.tranche);
    const result = this.atomic(() => {
      const r = this.row(request.tranche);
      requireThat(r.agent_key === request.agentKey, 'wrong agent');
      const bit = this.operations[`${request.method} ${request.path}`];
      requireThat(bit && (r.P & bit) === bit, 'operation denied');
      requireThat(!r.stopped && r.T >= this.now() && r.remaining > 0, 'stopped, expired or exhausted');
      this.record(request, 'use', payload);
      const change = this.prepare('UPDATE tranches SET remaining=remaining-1,used=used+1 WHERE id=? AND remaining>0 AND stopped=0').run(request.tranche);
      requireThat(change.changes === 1, 'exhausted');
      return { remaining: r.remaining - 1 };
    });
    const authorization = { ...result, decisionMs: performance.now() - started };
    Object.defineProperty(authorization,'receipt',{value:{tranche:request.tranche,nonce:request.nonce}});
    return authorization;
  }
  trackUpstream(receipt) { this.pendingUpstream.add(JSON.stringify(receipt)); }
  finishUpstream(receipt) { this.pendingUpstream.delete(JSON.stringify(receipt)); }
  refund(receipt) {
    const result = this.atomic(() => {
      const changed = this.prepare("UPDATE events SET kind='refund' WHERE tranche=? AND nonce=? AND kind='use'").run(receipt.tranche,receipt.nonce);
      if (!changed.changes) return false;
      const row = this.row(receipt.tranche);
      if (row.reason === 'local-stop') {
        this.prepare('UPDATE tranches SET used=used-1,n=n-1 WHERE id=?').run(receipt.tranche);
        // Stopped delegated allocations have already returned their unused quota.
        let id = receipt.tranche;
        while (true) {
          const link = this.prepare('SELECT parent,returned FROM delegations WHERE child=?').get(id);
          if (!link?.returned) break;
          id = link.parent;
          const parent = this.row(id);
          if (parent.reason !== 'local-stop') {
            this.prepare('UPDATE tranches SET n=n+1,remaining=remaining+1 WHERE id=?').run(id);break;
          }
        }
      } else this.prepare('UPDATE tranches SET used=used-1,remaining=remaining+1 WHERE id=?').run(receipt.tranche);
      this.prepare("UPDATE settlements SET k=k-1 WHERE tranche=? AND status='pending' AND k>1").run(receipt.tranche);
      this.prepare("DELETE FROM settlements WHERE tranche=? AND status='pending' AND k=1 AND ?=1").run(receipt.tranche,row.used);
      return true;
    });
    this.finishUpstream(receipt);
    return result;
  }
  async stop(request) {
    requireThat(request.method === 'POST' && request.path === '/stop', 'invalid stop request');
    const payload = verifySigned(request);
    this.checkAgentRate(request.agentKey);
    return this.atomic(() => {
      const r = this.row(request.tranche);
      requireThat(JSON.parse(r.ancestors).includes(request.agentKey), 'not an ancestor');
      this.record(request, 'stop', payload);
      if (r.used > 0) this.queueSettlement(request.tranche, r.used);
      this.prepare("UPDATE tranches SET stopped=1,reason='ancestor' WHERE id=?").run(request.tranche);
      return this.status(request.tranche);
    });
  }
  queueSettlement(id, k) {
    this.prepare('INSERT INTO settlements(tranche,k) VALUES(?,?) ON CONFLICT(tranche) DO NOTHING').run(id, k);
  }
  pendingSettlements() { return this.prepare("SELECT tranche,k,status FROM settlements WHERE status!='done' ORDER BY rowid").all(); }
  async settle(id, { lockTime = 0 } = {}) {
    validateID(id);
    requireThat(![...this.pendingUpstream].some(value=>JSON.parse(value).tranche === id), 'upstream admission pending');
    const k = this.atomic(() => {
      const r = this.row(id);
      requireThat(r.used >= 1, 'unused tranche');
      this.queueSettlement(id, r.used);
      if (!r.stopped) this.prepare("UPDATE tranches SET stopped=1,reason='settle' WHERE id=?").run(id);
      return this.prepare('SELECT k FROM settlements WHERE tranche=?').get(id).k;
    });
    const previous = this.prepare('SELECT * FROM settlements WHERE tranche=?').get(id);
    if (previous.status === 'done') return JSON.parse(previous.result);
    const result = await this.ledger.settle(id, k, { key: this.key, lockTime });
    if (result.ok) {
      requireThat(typeof result.settled === 'boolean', 'Ledger settlement state required');
      const persisted = result.record ?? result;
      this.prepare('UPDATE settlements SET status=?,result=? WHERE tranche=?')
        .run(result.settled ? 'done' : 'built', JSON.stringify(persisted), id);
    }
    return result;
  }
}
