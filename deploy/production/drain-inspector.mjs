#!/usr/bin/env node
// Short-lived, loopback-only maintenance for already-running releases without a drain endpoint.
// Never creates a queue client/handler. PID + process start time and the release record own recovery.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';

const args = Object.fromEntries(process.argv.slice(2).map((x, i, a) => x.startsWith('--') ? [x.slice(2), a[i + 1]] : []).filter(x => x.length));
const pid = Number(args.pid), port = Number(args.port ?? 9229), budget = Number(args['wait-seconds'] ?? 60);
if (!['worker', 'http'].includes(args.kind) || !Number.isInteger(pid) || pid <= 1 || !args.id || !args.state || !args.start || !args.cwd || !Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isFinite(budget) || budget <= 0) throw Error('Usage: drain-inspector.mjs --kind worker|http --pid PID --start PROC_START --cwd FIXED_RELEASE --port PORT --id RELEASE_ID --state FILE [--api-port PORT] [--wait-seconds N]');
const endpoint = `http://127.0.0.1:${port}`;
const start = async () => process.platform === 'linux'
  ? (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19]
  : execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
if (await start() !== args.start) throw Error('Process identity changed; drain refused');
let record = existsSync(args.state) ? JSON.parse(await readFile(args.state, 'utf8')) : { id: args.id, pid, start: args.start, kind: args.kind, opened: false };
if (record.id !== args.id || record.pid !== pid || record.start !== args.start || record.kind !== args.kind) throw Error('Drain record identity conflict');
async function save() { await writeFile(`${args.state}.next`, JSON.stringify(record), { mode: 0o600 }); await rename(`${args.state}.next`, args.state); }
async function targets() { try { const r = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1000) }); return await r.json(); } catch { return null; } }
async function listening() {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}
let ws, serial = 0, verified = false;
const pending = new Map();
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(Error('Inspector command timed out')); }, 5000); pending.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression, byValue = true) {
  const r = await rpc('Runtime.evaluate', { expression, returnByValue: byValue, awaitPromise: true });
  if (r.exceptionDetails) throw Error('Runtime maintenance expression failed; original process retained');
  return r.result;
}
const end = Date.now() + budget * 1000;
async function until(fn, label) { while (!(await fn())) { if (Date.now() >= end) throw Error(`Drain wait incomplete: ${label}; resume the same release`); await delay(100); } }
try {
  let list = await targets();
  if (list && !record.opened) throw Error('Inspector port already in use and is not owned by this drain record');
  if (!list) {
    if (await listening()) throw Error('Selected port is occupied by an unverified listener');
    record.opened = true; await save();
    if (await start() !== args.start) throw Error('Process identity changed before inspector activation');
    process.kill(pid, 'SIGUSR1');
    await until(async () => { list = await targets(); return list?.length; }, 'inspector startup');
  }
  if (list.length !== 1 || !list[0].webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`)) throw Error('Expected one loopback debugger target');
  ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Inspector connection timed out')), 3000); ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = e => { clearTimeout(timer); reject(e); }; });
  ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(Error('Inspector command failed')) : p.resolve(m.result); } };
  const identity = (await evaluate('({pid:process.pid,cwd:process.cwd()})')).value;
  if (identity.pid !== pid || identity.cwd !== args.cwd || await start() !== args.start) throw Error('Connected process does not match fixed release identity');
  verified = true;
  const key = '__aihotOnlineDrain';
  const previous = (await evaluate(`globalThis.${key} ? {id:globalThis.${key}.id,kind:globalThis.${key}.kind,state:globalThis.${key}.state} : null`)).value;
  if (previous && (previous.id !== args.id || previous.kind !== args.kind)) throw Error('Another release owns this runtime drain');
  if (!previous && args.kind === 'worker') {
    const entry = `${args.cwd}/node_modules/pg-boss/dist/index.js`;
    const version = JSON.parse(await readFile(`${args.cwd}/node_modules/pg-boss/package.json`, 'utf8')).version;
    if (version !== '12.34.0') throw Error('Unverified pg-boss version; old worker retained');
    const proto = await evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(`${args.cwd}/package.json`)})(${JSON.stringify(entry)}).PgBoss.prototype`, false);
    const objects = await rpc('Runtime.queryObjects', { prototypeObjectId: proto.objectId });
    const initialized = await rpc('Runtime.callFunctionOn', { objectId: objects.objects.objectId, returnByValue: true,
      functionDeclaration: `function(){if(this.length!==1)throw Error('ambiguous existing queue client');const boss=this[0];const rows=boss.getWipData();if(!rows.length)throw Error('no registered workers');const names=[...new Set(rows.map(x=>x.name))];const state={id:${JSON.stringify(args.id)},kind:'worker',state:'draining',boss,names};globalThis.${key}=state;state.promise=Promise.all(names.map(name=>boss.offWork(name,{wait:true}))).then(()=>{state.state=boss.getWipData().length===0?'drained':'failed'},()=>{state.state='failed'});return {workers:rows.length,queues:names.length};}` });
    if (initialized.exceptionDetails) throw Error('Existing queue client could not be identified; no replacement created');
    record.workers = initialized.result.value.workers; record.queues = initialized.result.value.queues; await save();
  }
  if (!previous && args.kind === 'http') {
    const version = JSON.parse(await readFile(`${args.cwd}/node_modules/@modelcontextprotocol/server/package.json`, 'utf8')).version;
    if (version !== '2.1.0') throw Error('Unverified MCP SDK version; API retained');
    const sourcePath = `${args.cwd}/apps/api/src/routes/mcp.ts`;
    const source = await readFile(sourcePath, 'utf8');
    const lines = source.split('\n'); const line = lines.findIndex(x => x.includes('const res = await handler.fetch('));
    if (line < 0 || lines.filter(x => x.includes('const res = await handler.fetch(')).length !== 1) throw Error('Unrecognized MCP handler source');
    record.sourceSha256 = createHash('sha256').update(source).digest('hex');
    await rpc('Debugger.enable');
    // A prior interrupted connection may have left a breakpoint. Its precise ID is persisted.
    if (record.breakpoint) await rpc('Debugger.removeBreakpoint', { breakpointId: record.breakpoint }).catch(() => {});
    const bp = await rpc('Debugger.setBreakpointByUrl', { url: pathToFileURL(sourcePath).href, lineNumber: line,
      condition: `globalThis.${key}={id:${JSON.stringify(args.id)},kind:'http',state:'captured',handler},false` });
    record.breakpoint = bp.breakpointId; await save();
    const response = await fetch(`http://127.0.0.1:${Number(args['api-port'])}/api/mcp`, { headers: { host: 'news.aiplanet.live' }, signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    await rpc('Debugger.removeBreakpoint', { breakpointId: record.breakpoint }); delete record.breakpoint; await save();
  }
  if (args.kind === 'http') {
    // close() itself closes ordinary tool requests too. Only its captured subscription router is used.
    const fn = await evaluate(`globalThis.${key}.handler.close`, false);
    const properties = await rpc('Runtime.getProperties', { objectId: fn.objectId, ownProperties: false });
    const scopes = properties.internalProperties?.find(x => x.name === '[[Scopes]]');
    if (!scopes) throw Error('MCP closure unavailable; subscriptions retained');
    const scopeList = await rpc('Runtime.getProperties', { objectId: scopes.value.objectId, ownProperties: true });
    let router;
    for (const scope of scopeList.result) {
      if (!scope.value?.objectId) continue;
      const vars = await rpc('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      const found = vars.result.find(x => x.name === 'listenRouter'); if (found) { router = found.value.objectId; break; }
    }
    if (!router) throw Error('Existing subscription router not found; no broader shutdown attempted');
    const drained = await rpc('Runtime.callFunctionOn', { objectId: router, returnByValue: true,
      functionDeclaration: `function(){if(typeof this.closeAll!=='function'||!Number.isInteger(this.openCount))throw Error('wrong router');const before=this.openCount;this.closeAll();globalThis.${key}.state='drained';return {before,after:this.openCount};}` });
    if (drained.exceptionDetails || drained.result.value.after !== 0) throw Error('Subscription drain incomplete');
    record.subscriptions = drained.result.value;
  }
  await until(async () => {
    const state = (await evaluate(`globalThis.${key}.state`)).value;
    if (state === 'failed') throw Error('Existing worker drain failed; original instance retained');
    return state === 'drained';
  }, 'in-flight callbacks');
  record.status = 'drained'; await save();
} catch (error) {
  record.status = 'pending'; record.reason = String(error.message); await save();
  process.exitCode = 4;
} finally {
  if (verified && ws?.readyState === WebSocket.OPEN) {
    if (record.breakpoint) { await rpc('Debugger.removeBreakpoint', { breakpointId: record.breakpoint }).catch(() => {}); delete record.breakpoint; }
    await evaluate("setTimeout(()=>process.getBuiltinModule('inspector').close(),30);true").catch(() => {});
    ws.close();
    await delay(100);
    record.debuggerClosed = !(await listening());
    record.opened = !record.debuggerClosed;
    if (!record.debuggerClosed) { record.status = 'pending'; record.reason = 'Debug listener closure not verified'; process.exitCode = 4; }
    await save();
  } else ws?.close();
  console.log(JSON.stringify({ id: record.id, kind: record.kind, status: record.status, debuggerClosed: record.debuggerClosed ?? false, reason: record.reason ?? null }));
}
