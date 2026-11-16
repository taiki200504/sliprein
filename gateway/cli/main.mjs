#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openState, NAME } from './state.mjs';
import { createProxyServer } from '../proxy.mjs';

export async function main(argv = process.argv.slice(2)) {
  const args = []; const options = {};
  for (let i=0;i<argv.length;i++) {
    if (argv[i].startsWith('--')) {
      const key=argv[i].slice(2);
      if (!['state','upstream','port','calls','ttl','scope'].includes(key) || options[key] !== undefined || !argv[i+1] || argv[i+1].startsWith('--')) throw Error('invalid option');
      options[key]=argv[++i];
    } else args.push(argv[i]);
  }
  const [command, name, child] = args;
  if (!command || ['help','-h'].includes(command)) {
    console.log(`${NAME} serve --upstream <origin> [--port 8787]\n${NAME} issue <agent> [--calls 100] [--ttl 86400] [--scope 15]\n${NAME} delegate <parent> <child> --calls <n>\n${NAME} token <agent>\n${NAME} stop <agent>\n${NAME} status [agent]\nGlobal: --state <private-directory> (default ~/.<package-name>)\nserve requires UPSTREAM_API_KEY; listens on 127.0.0.1.`); return;
  }
  if (!['serve','issue','delegate','token','stop','status'].includes(command)) throw Error('unknown command');
  const count = command === 'delegate' ? 3 : command === 'status' ? (name ? 2 : 1) : command === 'serve' ? 1 : 2;
  if (args.length !== count || (command !== 'serve' && !name && command !== 'status')) throw Error('invalid arguments');
  const integer = (key, fallback) => {
    const value = options[key] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)>0x7fffffff) throw Error(`invalid ${key}`);
    return Number(value);
  };
  const state = openState(resolve(options.state ?? join(homedir(), '.'+NAME)));
  try {
    let result;
    if (command === 'issue') result = state.issue(name, {n:integer('calls',100),P:integer('scope',15),T:Math.floor(Date.now()/1000)+integer('ttl',86400)});
    if (command === 'delegate') { if (!options.calls) throw Error('--calls required'); result = state.delegate(name,child,integer('calls')); }
    if (command === 'token') result = state.token(name);
    if (command === 'stop') result = state.stop(name);
    if (command === 'status') result = state.status(name);
    if (command === 'serve') {
      if (!options.upstream) throw Error('--upstream required');
      const port = integer('port',8787); if (port>65535) throw Error('invalid port');
      const server = createProxyServer(state.gateway, {upstream:options.upstream,apiKey:process.env.UPSTREAM_API_KEY,control:state});
      await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});
      console.log(`${NAME} listening on http://127.0.0.1:${port}/v1`);
      await new Promise(resolve => {
        const shutdown=()=>{server.closeAllConnections();server.close(resolve);};
        process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
      });
    } else console.log(typeof result === 'string' ? result : JSON.stringify(result));
  } finally { state.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => { console.error(`${NAME}: command failed (check arguments, state permissions, and upstream configuration)`); process.exitCode=1; });
}
