import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { requireThat, validateID, keyObject, publicKey, ancestryRoot, verifySigned, signingPayload } from './auth.mjs';
import { MemoryLedger, SqliteLedger } from './ledger.mjs';
export { Denied, publicKey, sign, signingPayload, verifySigned } from './auth.mjs';
export { MemoryLedger, SqliteLedger } from './ledger.mjs';
export { createServer } from './http.mjs';

export class Gateway {
  constructor({ key, ledger, filename = ':memory:', operations, now = () => Math.floor(Date.now() / 1000) }) {
    this.key = key; this.holder = publicKey(key); this.now = now;
    this.db = new DatabaseSync(filename);
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
      CREATE TABLE IF NOT EXISTS settlements (tranche TEXT PRIMARY KEY, k INTEGER NOT NULL CHECK(k>0), status TEXT NOT NULL DEFAULT 'pending', result TEXT);`);
  }
  close() { this.db.close(); if (this.ownsLedger) this.ledger.close(); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(id) { validateID(id); const r = this.db.prepare('SELECT * FROM tranches WHERE id=?').get(id); requireThat(r, 'unknown tranche'); return r; }
  status(id) { const r = this.row(id); return { remaining: r.remaining, used: r.used, stopped: r.stopped }; }
  receipts(id) { this.row(id); return this.db.prepare("SELECT nonce,payload,signature,agent_key,created_at FROM events WHERE tranche=? AND kind='use' ORDER BY rowid").all(id); }
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
      requireThat(!this.db.prepare('SELECT 1 FROM tranches WHERE id=?').get(id), 'already bound');
      this.db.prepare('INSERT INTO tranches(id,ancestors,agent_key,n,remaining,P,T) VALUES(?,?,?,?,?,?,?)')
        .run(id, JSON.stringify(ancestors), ancestors.at(-1), s.n, s.n, s.P, s.T);
      return this.status(id);
    });
  }
  async checkLedger(id) {
    validateID(id);
    const spent = await this.ledger.isSpent(id);
    if (spent === true) this.db.prepare("UPDATE tranches SET stopped=1,reason='ledger-spent' WHERE id=?").run(id);
    requireThat(spent === false, 'spent or unavailable');
  }
  async monitor() {
    const rows = this.db.prepare('SELECT id FROM tranches WHERE stopped=0').all();
    for (const { id } of rows) {
      const spent = await this.ledger.isSpent(id);
      requireThat(typeof spent === 'boolean', 'ledger unavailable');
      if (spent) this.db.prepare("UPDATE tranches SET stopped=1,reason='ledger-spent' WHERE id=?").run(id);
    }
  }
  record(request, kind, payload) {
    requireThat(!this.db.prepare('SELECT 1 FROM events WHERE tranche=? AND nonce=?').get(request.tranche, request.nonce), 'nonce replay');
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(request.tranche, request.nonce, kind, payload, request.signature, request.agentKey, this.now());
  }
  async authorize(request) {
    request = { ...request, body: Buffer.isBuffer(request.body) ? Buffer.from(request.body) : request.body };
    const started = performance.now();
    const payload = verifySigned(request);
    return this.authorizeChecked(request, payload, started);
  }
  issueToken(tranche, agentKey) {
    const row = this.row(tranche);
    requireThat(row.agent_key === agentKey && !row.stopped && row.T >= this.now(), 'wrong or inactive agent');
    const token = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(token).digest('hex');
    this.db.prepare('INSERT INTO agent_tokens VALUES(?,?,?)').run(digest, tranche, agentKey);
    return token;
  }
  resolveToken(token) {
    requireThat(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'invalid token');
    const digest = createHash('sha256').update(token).digest('hex');
    const binding = this.db.prepare('SELECT * FROM agent_tokens WHERE digest=?').get(digest);
    requireThat(binding, 'unknown token');
    return binding;
  }
  async authorizeBearer(token, request) {
    const binding = this.resolveToken(token);
    request = { ...request, tranche: binding.tranche, agentKey: binding.agent_key, nonce: randomUUID(), signature: 'bearer:' + binding.digest };
    const payload = signingPayload(request);
    return this.authorizeChecked(request, payload, performance.now());
  }
  async authorizeChecked(request, payload, started) {
    this.row(request.tranche);
    await this.checkLedger(request.tranche);
    const result = this.atomic(() => {
      const r = this.row(request.tranche);
      requireThat(r.agent_key === request.agentKey, 'wrong agent');
      const bit = this.operations[`${request.method} ${request.path}`];
      requireThat(bit && (r.P & bit) === bit, 'operation denied');
      requireThat(!r.stopped && r.T >= this.now() && r.remaining > 0, 'stopped, expired or exhausted');
      this.record(request, 'use', payload);
      const change = this.db.prepare('UPDATE tranches SET remaining=remaining-1,used=used+1 WHERE id=? AND remaining>0 AND stopped=0').run(request.tranche);
      requireThat(change.changes === 1, 'exhausted');
      return { remaining: r.remaining - 1 };
    });
    return { ...result, decisionMs: performance.now() - started };
  }
  async stop(request) {
    requireThat(request.method === 'POST' && request.path === '/stop', 'invalid stop request');
    const payload = verifySigned(request);
    return this.atomic(() => {
      const r = this.row(request.tranche);
      requireThat(JSON.parse(r.ancestors).includes(request.agentKey), 'not an ancestor');
      this.record(request, 'stop', payload);
      if (r.used > 0) this.queueSettlement(request.tranche, r.used);
      this.db.prepare("UPDATE tranches SET stopped=1,reason='ancestor' WHERE id=?").run(request.tranche);
      return this.status(request.tranche);
    });
  }
  queueSettlement(id, k) {
    this.db.prepare('INSERT INTO settlements(tranche,k) VALUES(?,?) ON CONFLICT(tranche) DO NOTHING').run(id, k);
  }
  pendingSettlements() { return this.db.prepare("SELECT tranche,k,status FROM settlements WHERE status!='done' ORDER BY rowid").all(); }
  async settle(id, { lockTime = 0 } = {}) {
    validateID(id);
    const k = this.atomic(() => {
      const r = this.row(id);
      requireThat(r.used >= 1, 'unused tranche');
      this.queueSettlement(id, r.used);
      if (!r.stopped) this.db.prepare("UPDATE tranches SET stopped=1,reason='settle' WHERE id=?").run(id);
      return this.db.prepare('SELECT k FROM settlements WHERE tranche=?').get(id).k;
    });
    const previous = this.db.prepare('SELECT * FROM settlements WHERE tranche=?').get(id);
    if (previous.status === 'done') return JSON.parse(previous.result);
    const result = await this.ledger.settle(id, k, { key: this.key, lockTime });
    if (result.ok) {
      requireThat(typeof result.settled === 'boolean', 'Ledger settlement state required');
      const persisted = result.record ?? result;
      this.db.prepare('UPDATE settlements SET status=?,result=? WHERE tranche=?')
        .run(result.settled ? 'done' : 'built', JSON.stringify(persisted), id);
    }
    return result;
  }
}
