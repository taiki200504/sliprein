import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { requireThat, validateID, keyObject, publicKey, ancestryRoot } from './auth.mjs';

/**
 * Ledger interface (authority source, independent of the gateway's usage database):
 * readTranche(id) -> {id,holder,R,d,n,P,T,phase}; isSpent(id) -> boolean;
 * settle(id,k,{key,lockTime}) -> {ok,settled,kind,k,record?,...}. All three may return promises.
 * Implementations are trusted to enforce issuance/delegation and one-time consumption.
 */
export class SqliteLedger {
  constructor({ filename = ':memory:', db } = {}) {
    this.ownsDb = !db;
    this.db = db ?? new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS ledger_tranches(id TEXT PRIMARY KEY,data TEXT NOT NULL,spent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ledger_settlements(id TEXT PRIMARY KEY,k INTEGER NOT NULL,result TEXT NOT NULL);`);
  }
  close() { if (!this.closed) { if (this.ownsDb) this.db.close(); this.closed = true; } }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  issue({ holder, ancestors = [], n, P, T }) {
    keyObject(holder);
    requireThat(Array.isArray(ancestors) && ancestors.length <= 8, 'invalid ancestry');
    for (const key of ancestors) keyObject(key);
    for (const value of [n, P, T]) requireThat(Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff, 'invalid tranche state');
    const id = `${randomBytes(32).toString('hex')}:0`;
    const state = { id, holder, ancestors: [...ancestors], R: ancestryRoot(ancestors), d: ancestors.length, n, P, T, phase: 0 };
    this.db.prepare('INSERT INTO ledger_tranches(id,data) VALUES(?,?)').run(id, JSON.stringify(state));
    return id;
  }
  stored(id) { validateID(id); return this.db.prepare('SELECT data,spent FROM ledger_tranches WHERE id=?').get(id); }
  async readTranche(id) { const row = this.stored(id); return row && !row.spent ? JSON.parse(row.data) : undefined; }
  async isSpent(id) { const row = this.stored(id); return !row || !!row.spent; }
  spend(id) { validateID(id); this.db.prepare('UPDATE ledger_tranches SET spent=1 WHERE id=?').run(id); }
  delegate(id, { key, children }) {
    return this.atomic(() => {
      const row = this.stored(id); requireThat(row && !row.spent, 'missing or spent tranche');
      const parent = JSON.parse(row.data); requireThat(publicKey(key) === parent.holder, 'wrong holder');
      requireThat(Array.isArray(children) && children.length >= 1 && children.length <= 2 && parent.d < 8, 'invalid children');
      let sum = 0;
      const ids = children.map(child => {
        requireThat(Number.isSafeInteger(child.n) && child.n >= 0 && (child.P & parent.P) === child.P && child.T <= parent.T, 'invalid attenuation');
        sum += child.n; requireThat(sum <= parent.n, 'excess delegation');
        return this.issue({ ...child, ancestors: [...parent.ancestors, parent.holder] });
      });
      this.spend(id);
      return { ids, burned: parent.n - sum };
    });
  }
  async settle(id, k, { key }) {
    return this.atomic(() => {
      validateID(id);
      const existing = this.db.prepare('SELECT k,result FROM ledger_settlements WHERE id=?').get(id);
      const row = this.stored(id); requireThat(row && publicKey(key) === JSON.parse(row.data).holder, 'wrong holder');
      if (existing) { requireThat(existing.k === k, 'settlement count changed'); return JSON.parse(existing.result); }
      requireThat(!row.spent, 'spent tranche'); const parent = JSON.parse(row.data);
      requireThat(Number.isSafeInteger(k) && k >= 1 && k <= parent.n, 'invalid settlement count');
      const outputId = this.issue({ ...parent, n: parent.n - k });
      this.spend(id);
      const result = { ok: true, settled: true, kind: 'sqlite', k, remaining: parent.n - k, output: { id: outputId } };
      this.db.prepare('INSERT INTO ledger_settlements VALUES(?,?,?)').run(id, k, JSON.stringify(result));
      return result;
    });
  }
}
export class MemoryLedger extends SqliteLedger {
  constructor() { super(); }
}
