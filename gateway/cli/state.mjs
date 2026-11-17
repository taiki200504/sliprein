import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';
import { Gateway, publicKey } from '../index.mjs';
import { requireThat } from '../auth.mjs';
import { OPENAI_OPERATIONS } from '../proxy.mjs';

// The display name lives in package.json; all CLI help reads it there.
export const NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).name;
function keyFromHex(hex) {
  const ec = createECDH('secp256k1'); ec.setPrivateKey(Buffer.from(hex, 'hex'));
  return { toHex: () => hex, toPublicKey: () => ({ toString: () => ec.getPublicKey('hex', 'compressed') }) };
}
export function openState(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  requireThat(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0, 'state directory must be private and owned by this user');
  const keyPath = join(directory, 'gateway.key');
  let hex;
  try { hex = readFileSync(keyPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const ec = createECDH('secp256k1'); ec.generateKeys(); hex = ec.getPrivateKey('hex');
    try { writeFileSync(keyPath, hex, { mode: 0o600, flag: 'wx' }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; hex = readFileSync(keyPath, 'utf8'); }
  }
  const keyInfo = lstatSync(keyPath);
  requireThat(keyInfo.isFile() && keyInfo.uid === process.getuid() && (keyInfo.mode & 0o077) === 0 && /^[0-9a-f]{64}$/.test(hex), 'gateway key must be private');
  const gateway = new Gateway({ key: keyFromHex(hex), filename: join(directory, 'state.sqlite'), operations: OPENAI_OPERATIONS });
  gateway.db.exec(`CREATE TABLE IF NOT EXISTS agents(name TEXT PRIMARY KEY, tranche TEXT NOT NULL UNIQUE, agent_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delegations(child TEXT PRIMARY KEY,parent TEXT NOT NULL,returned INTEGER NOT NULL DEFAULT 0);`);
  // Recover parent links for stores created before explicit delegation metadata. Previously stopped allocations stay retired.
  gateway.db.exec(`INSERT OR IGNORE INTO delegations(child,parent,returned)
    SELECT child.tranche,parent.tranche,tranches.stopped FROM agents child JOIN tranches ON tranches.id=child.tranche
    JOIN agents parent ON parent.agent_key=json_extract(tranches.ancestors,'$[#-2]');`);
  const agent = name => { const r = gateway.db.prepare('SELECT * FROM agents WHERE name=?').get(name); requireThat(r, 'unknown agent'); return r; };
  const validate = name => requireThat(typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name), 'invalid agent name');
  function create(name, { n = 100, P = 15, T = Math.floor(Date.now()/1000)+86400, ancestors = [] } = {}) {
    validate(name); requireThat(!gateway.db.prepare('SELECT 1 FROM agents WHERE name=?').get(name), 'agent already exists');
    const ec = createECDH('secp256k1'); ec.generateKeys(); const agentKey = ec.getPublicKey('hex','compressed');
    const keys = [...ancestors, agentKey]; requireThat(keys.length <= 8, 'maximum delegation depth');
    const id = gateway.ledger.issue({ holder: publicKey(gateway.key), ancestors: keys, n, P, T });
    // Issuance and binding share the same SQLite transaction, including delegated quotas.
    gateway.db.prepare('INSERT INTO tranches(id,ancestors,agent_key,n,remaining,P,T) VALUES(?,?,?,?,?,?,?)').run(id,JSON.stringify(keys),agentKey,n,n,P,T);
    gateway.db.prepare('INSERT INTO agents VALUES(?,?,?)').run(name,id,agentKey);
    return { agent: name, tranche: id, remaining: n };
  }
  function delegate(parent, child, n, { P, T } = {}) {
    const source = agent(parent), row = gateway.row(source.tranche);
    requireThat(Number.isSafeInteger(n) && n > 0 && n <= row.remaining && !row.stopped && row.T >= gateway.now(), 'invalid delegation');
    P ??= row.P; T ??= row.T;
    requireThat(Number.isInteger(P) && P > 0 && (P & row.P) === P && Number.isSafeInteger(T) && T > gateway.now() && T <= row.T, 'delegation must narrow scope and expiry');
    const result = create(child, {n, P, T, ancestors:JSON.parse(row.ancestors)});
    gateway.db.prepare('INSERT INTO delegations(child,parent) VALUES(?,?)').run(result.tranche,source.tranche);
    // A delegated call is reserved from the parent, not charged as an executed call.
    gateway.db.prepare('UPDATE tranches SET n=n-?,remaining=remaining-? WHERE id=?').run(n,n,source.tranche);
    return result;
  }
  const control = {
    gateway,
    issue: (name, options) => gateway.atomic(() => create(name, options)),
    delegate(parent, child, n, options) { return gateway.atomic(() => delegate(parent,child,n,options)); },
    token(name) { const row = agent(name); return gateway.issueToken(row.tranche,row.agent_key); },
    stop(name) {
      return gateway.atomic(() => {
        const source = agent(name); const key = source.agent_key;
        const rows = gateway.db.prepare('SELECT id,ancestors FROM tranches').all()
          .filter(row => JSON.parse(row.ancestors).includes(key))
          .sort((a,b) => JSON.parse(b.ancestors).length - JSON.parse(a.ancestors).length);
        for (const {id} of rows) {
          const row = gateway.row(id);
          const link = gateway.db.prepare('SELECT parent,returned FROM delegations WHERE child=?').get(id);
          if (link && !link.returned) {
            const parent = gateway.row(link.parent);
            requireThat(!parent.stopped, 'parent already stopped without reclaim');
            gateway.db.prepare('UPDATE tranches SET n=n+?,remaining=remaining+? WHERE id=?').run(row.remaining,row.remaining,link.parent);
            gateway.db.prepare('UPDATE delegations SET returned=1 WHERE child=?').run(id);
          }
          gateway.db.prepare("UPDATE tranches SET stopped=1,reason='local-stop',n=used,remaining=0 WHERE id=?").run(id);
          if (row.used) gateway.queueSettlement(id,row.used);
        }
        return gateway.status(source.tranche);
      });
    },
    delegateToken(token, {name,calls,scope,expiresAt}) {
      return gateway.atomic(() => {
        const binding = gateway.resolveToken(token); gateway.checkAgentRate(binding.agent_key); const row = gateway.row(binding.tranche);
        requireThat(!row.stopped && row.T >= gateway.now(), 'inactive agent');
        const parent = gateway.db.prepare('SELECT name FROM agents WHERE tranche=?').get(binding.tranche);
        requireThat(parent, 'unmanaged agent');
        const child = delegate(parent.name,name,calls,{P:scope,T:expiresAt});
        return {...child,token:control.token(name)};
      });
    },
    stopToken(token) {
      const binding = gateway.resolveToken(token); gateway.checkAgentRate(binding.agent_key);
      const source = gateway.db.prepare('SELECT name FROM agents WHERE tranche=?').get(binding.tranche);
      requireThat(source, 'unmanaged agent');return control.stop(source.name);
    },
    status(name) { return name ? {agent:name,...gateway.status(agent(name).tranche)} : gateway.db.prepare('SELECT agents.name AS agent,tranches.remaining,tranches.used,tranches.stopped FROM agents JOIN tranches ON agents.tranche=tranches.id ORDER BY agents.name').all(); },
    close: () => gateway.close(),
  };
  return control;
}
