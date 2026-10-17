import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const help = `Usage: node scripts/check-family-local.mjs --run
Starts only new disposable same-host Pico daemons; no existing instance arguments accepted.
Exercises CLI pairing, signed Unix RPC, shared checklists, actual timer/SSE reminders,
restart persistence and revocation. No model inference, real Telegram or Docker.
Private report/logs remain under /tmp; temporary instances and owned processes are cleaned up.
Build first with pnpm build. --help performs no file or process operations.`;
if (process.argv.length === 3 && process.argv[2] === '--help') { console.log(help); process.exit(0); }
if (process.argv.length !== 3 || process.argv[2] !== '--run') { console.error(help); process.exit(1); }
assert.equal(process.version, 'v24.21.0', 'Select the pinned Node 24.21.0 before running this check');
const repo = fileURLToPath(new URL('../', import.meta.url)), cliPath = join(repo, 'dist/cli.js');
assert(existsSync(cliPath), 'Build first: pnpm build');
const { Client } = await import('../dist/client.js');
const { loadConfig, atomicWrite } = await import('../dist/config.js');
const directory = mkdtempSync('/tmp/pico-family-local-');
mkdirSync(join(directory, 'home'), { mode: 0o700 });
const env = { PATH: process.env.PATH, HOME: join(directory, 'home'), LANG: 'en_US.UTF-8' };
const execute = promisify(execFile), owners = [], logs = [];
const names = ['independent compiled daemons', 'bilateral consent and private defaults', 'reminder consent denied by default',
  'read-only checklist sharing', 'revision-safe edits and pagination', 'unsharing', 'real timer and terminal SSE delivery',
  'restart persistence and reverse reminder', 'revocation and pending cancellation', 'no model usage or borrowed credentials', 'atomic create-and-share defaults to read/write'];
const report = { version: 1, startedAt: new Date().toISOString(), runtime: process.version, environment: 'disposable local compiled CLI daemons',
  liveModel: false, realTelegram: false, osIsolationVerified: false, checks: names.map(name => ({ name, status: 'not_run' })) };
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
async function check(name, fn) {
  assert(!interrupted, 'Interrupted');
  const result = report.checks.find(check => check.name === name); result.status = 'running';
  try { await fn(); result.status = 'passed'; console.log(`PASS ${name}`); }
  catch (error) { result.status = 'failed'; result.error = error.message; throw error; }
}
async function poll(name, read, ready, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  do {
    assert(!interrupted, 'Interrupted');
    const result = await read(); if (ready(result)) return result;
    await sleep(80);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${name}`);
}
async function cli(owner, ...args) {
  const result = await execute(process.execPath, [cliPath, '--instance', owner.root, ...args], { cwd: repo, env, timeout: 20_000, maxBuffer: 2_000_000 });
  return JSON.parse(result.stdout);
}
async function start(owner) {
  const log = openSync(join(directory, `${owner.name}.log`), 'a', 0o600); logs.push(log);
  const child = spawn(process.execPath, [cliPath, '--instance', owner.root, 'serve'], { cwd: repo, env, stdio: ['ignore', log, log] });
  owner.child = child; owner.exited = once(child, 'exit');
  // Observe rejection immediately, including a failed spawn, before readiness polling awaits it.
  void owner.exited.catch(() => {});
  const status = await poll(`${owner.name} readiness`, async () => {
    assert.equal(child.exitCode, null, `${owner.name} exited during startup`);
    try { return await owner.client.rpc('status'); }
    catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return null; throw error; }
  }, value => value !== null);
  assert.equal(status.pid, child.pid, 'Never attach to an unexpected daemon');
  assert.equal(status.ownerId, owner.config.ownerId); assert.equal(status.instanceId, owner.config.instanceId);
  assert.equal(status.model.authentication, 'unconfigured');
  return status;
}
async function stop(owner) {
  owner.client?.close();
  if (!owner.child) return;
  if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
    assert.equal(owner.child.exitCode, 0, `${owner.name} exited unexpectedly`);
    return;
  }
  const child = owner.child;
  child.kill('SIGTERM');
  let timer;
  try {
    // Escalation is only for this script's own disposable child, never a discovered PID.
    timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const [code, signal] = await owner.exited;
    assert.equal(code, 0, `${owner.name} did not shut down cleanly (${signal ?? code})`);
  } finally { clearTimeout(timer); }
}
const family = (owner, args) => owner.client.rpc('family', args);
const items = (owner, id) => owner.client.rpc('knowledge', { action: 'items', id });
const at = (milliseconds = 3000) => new Date(Date.now() + milliseconds).toISOString();
async function subscribe(owner, events) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { owner.client.close(); reject(new Error('SSE connection timed out')); }, 5000);
    owner.client.subscribe(event => events.push(event), () => { clearTimeout(timer); reject(new Error('SSE disconnected')); }, () => { clearTimeout(timer); resolve(); });
  });
}
try {
  for (const name of ['a', 'b']) {
    const owner = { name, root: join(directory, name) }; owners.push(owner);
    await cli(owner, 'init', '--name', `Owner ${name.toUpperCase()}`);
    const settings = loadConfig(owner.root); owner.root = settings.root; owner.config = settings.config;
    delete owner.config.embeddings;
    // Only B's empty archive gets automatic ticks; A's documents must not trigger QMD model downloads.
    owner.config.limits.backgroundIntervalMs = name === 'b' ? 1000 : 600_000;
    atomicWrite(join(owner.root, 'config.json'), JSON.stringify(owner.config));
    owner.client = new Client(owner.root);
    await start(owner);
  }
  const [a, b] = owners, cardA = join(directory, 'a-card.json'), cardB = join(directory, 'b-card.json');
  const eventsA = [], eventsB = [];
  let shared, privateList;
  await check(names[0], async () => {
    const sa = await a.client.rpc('status'), sb = await b.client.rpc('status');
    assert.notEqual(sa.pid, sb.pid); assert.notEqual(sa.ownerId, sb.ownerId); assert.notEqual(sa.instanceId, sb.instanceId);
    report.daemonPids = [sa.pid, sb.pid];
    assert.equal(sa.database.quick_check, 'ok'); assert.equal(sb.database.quick_check, 'ok');
  });
  await check(names[1], async () => {
    await cli(a, 'family', 'identity', cardA); await cli(b, 'family', 'identity', cardB);
    await cli(a, 'family', 'add', cardB, '--name', 'Owner B');
    await assert.rejects(family(a, { action: 'catalog', member: 'Owner B' }), /acceptance unknown/);
    await cli(b, 'family', 'add', cardA, '--name', 'Owner A');
    assert.deepEqual((await family(a, { action: 'catalog', member: 'Owner B' })).result.lists, []);
    shared = await a.client.rpc('knowledge', { action: 'create', title: 'Test groceries', markdown: '- [ ] Apples\n- [ ] Rice', submission: 'local-check-shared' });
    privateList = await a.client.rpc('knowledge', { action: 'create', title: 'Test private list', markdown: '- [ ] PRIVATE_ONLY', submission: 'local-check-private' });
    assert.deepEqual((await family(b, { action: 'catalog', member: 'Owner A' })).result.lists, []);
    await assert.rejects(family(b, { action: 'read', member: 'Owner A', id: privateList.id }), /not shared/);
  });
  await check(names[2], async () => {
    await assert.rejects(family(a, { action: 'remind', member: 'Owner B', text: 'Denied without consent', at: at() }), /not authorized reminders/);
    assert.deepEqual(await b.client.rpc('schedules.list'), []);
    await cli(a, 'family', 'add', cardB, '--name', 'Owner B', '--allow-reminders');
    await cli(b, 'family', 'add', cardA, '--name', 'Owner A', '--allow-reminders');
  });
  await check(names[3], async () => {
    await family(a, { action: 'share', member: 'Owner B', id: shared.id, permission: 'read' });
    const catalog = (await family(b, { action: 'catalog', member: 'Owner A' })).result;
    assert.equal(catalog.lists.length, 1); assert.equal(catalog.lists[0].id, shared.id);
    const read = (await family(b, { action: 'read', member: 'Owner A', id: shared.id })).result;
    assert.deepEqual(read.items.map(item => item.text), ['Apples', 'Rice']);
    assert(!JSON.stringify(read).includes('PRIVATE_ONLY'));
    await assert.rejects(family(b, { action: 'add', member: 'Owner A', id: shared.id, items: ['Milk'] }), /permission denied/);
    assert.equal((await items(a, shared.id)).allItems, 2);
  });
  await check(names[4], async () => {
    await family(a, { action: 'share', member: 'Owner B', id: shared.id, permission: 'edit' });
    const before = (await items(a, shared.id)).items;
    await family(b, { action: 'add', member: 'Owner A', id: shared.id, items: ['Milk'] });
    const page = (await family(b, { action: 'read', member: 'Owner A', id: shared.id, limit: 1 })).result;
    assert.equal(page.nextOffset, 1); assert.equal(page.allItems, 3); assert.equal(page.items[0].id, before[0].id);
    const rest = (await family(b, { action: 'read', member: 'Owner A', id: shared.id, offset: page.nextOffset })).result;
    assert.equal(rest.nextOffset, null); assert.equal(rest.items.length, 2);
    await assert.rejects(family(b, { action: 'update', member: 'Owner A', id: shared.id, itemId: before[0].id, expectedRevision: 1, completed: true }), /Revision conflict/);
    await family(b, { action: 'update', member: 'Owner A', id: shared.id, itemId: before[0].id, expectedRevision: page.revision, completed: true });
    const updated = (await family(b, { action: 'read', member: 'Owner A', id: shared.id })).result;
    await family(b, { action: 'remove', member: 'Owner A', id: shared.id, itemId: before[1].id, expectedRevision: updated.revision });
    const canonical = await items(a, shared.id);
    assert.deepEqual(canonical.items.map(item => [item.text, item.completed]), [['Apples', true], ['Milk', false]]);
    assert.equal(canonical.items[0].id, before[0].id);
  });
  await check(names[5], async () => {
    await family(a, { action: 'unshare', member: 'Owner B', id: shared.id });
    await assert.rejects(family(b, { action: 'read', member: 'Owner A', id: shared.id }), /not shared/);
    await family(a, { action: 'share', member: 'Owner B', id: shared.id, permission: 'edit' });
  });
  await check(names[10], async () => {
    const created = await family(a, { action: 'create', title: 'Test shared errands', member: 'Owner B', items: [] });
    assert.equal(created.shared, true); assert.equal(created.permission, 'edit'); assert.equal(created.effect, 'created');
    const empty = (await family(b, { action: 'read', member: 'Owner A', id: created.id })).result;
    assert.deepEqual(empty.items, []);
    await family(b, { action: 'add', member: 'Owner A', id: created.id, items: ['Soap'] });
    assert.deepEqual((await items(a, created.id)).items.map(item => item.text), ['Soap']);
    assert((await family(b, { action: 'catalog', member: 'Owner A' })).result.lists.some(list => list.id === created.id && list.permission === 'edit'));
  });
  await check(names[6], async () => {
    await subscribe(a, eventsA); await subscribe(b, eventsB);
    const marker = 'LOCAL_CHECK_A_TO_B';
    const accepted = await family(a, { action: 'remind', member: 'Owner B', text: marker, at: at() });
    assert.equal(accepted.result.accepted, true); assert.equal(accepted.result.delivered, false);
    const delivered = await poll('B actual reminder delivery', () => b.client.rpc('notifications.list'), rows => rows.some(row => row.text.includes(marker) && row.status === 'sent'));
    assert.equal(delivered.find(row => row.text.includes(marker)).destination, 'terminal');
    await poll('B SSE notification', async () => eventsB, rows => rows.some(event => event.type === 'notification' && event.data.text.includes(marker)));
    assert(eventsB.some(event => event.type === 'notification' && event.data.text.includes('Family reminder from Owner A')));
    assert(!eventsA.some(event => event.type === 'notification' && event.data.text.includes(marker)));
    assert(!(await a.client.rpc('notifications.list')).some(row => row.text.includes(marker)));
  });
  await check(names[7], async () => {
    const marker = 'LOCAL_CHECK_B_TO_A_AFTER_RESTART', due = at();
    await family(b, { action: 'remind', member: 'Owner A', text: marker, at: due });
    const previousPid = a.child.pid;
    await stop(a); await sleep(Math.max(0, Date.parse(due) - Date.now() + 150)); await start(a);
    assert.notEqual(a.child.pid, previousPid);
    report.restartedPid = a.child.pid;
    const rows = await poll('A startup reminder delivery', () => a.client.rpc('notifications.list'), rows => rows.some(row => row.text.includes(marker) && row.status === 'sent'));
    assert.equal(rows.filter(row => row.text.includes(marker)).length, 1);
    assert(!(await b.client.rpc('notifications.list')).some(row => row.text.includes(marker)));
    const list = (await family(b, { action: 'read', member: 'Owner A', id: shared.id })).result;
    assert.deepEqual(list.items.map(item => [item.text, item.completed]), [['Apples', true], ['Milk', false]]);
  });
  await check(names[8], async () => {
    const marker = 'LOCAL_CHECK_CANCEL_ON_REVOKE';
    const accepted = await family(b, { action: 'remind', member: 'Owner A', text: marker, at: at(60_000) });
    await cli(a, 'family', 'revoke', 'Owner B');
    const row = (await a.client.rpc('schedules.list')).find(row => row.id === accepted.result.id);
    assert.equal(row.status, 'cancelled');
    assert(!(await a.client.rpc('notifications.list')).some(row => row.text.includes(marker)));
    await assert.rejects(family(b, { action: 'read', member: 'Owner A', id: shared.id }), /acceptance unknown/);
    await assert.rejects(family(a, { action: 'catalog', member: 'Owner B' }), /revoked/);
    assert.deepEqual((await family(a, { action: 'shares' })).shares, []);
    assert.equal((await items(a, shared.id)).allItems, 2);
  });
  await check(names[9], async () => {
    for (const owner of owners) {
      const status = await owner.client.rpc('status');
      assert.equal(status.model.authentication, 'unconfigured'); assert.deepEqual(status.usage, []); assert.deepEqual(status.nonAgentUsageSinceBoot, []);
      assert.equal(status.channels.length, 1); assert.equal(status.channels[0].id, 'terminal');
      const credentials = JSON.parse(readFileSync(join(owner.root, 'secrets.json'), 'utf8'));
      assert.deepEqual(credentials.entries, {}); assert.deepEqual(Object.keys(credentials.secrets), ['family.signingKey']);
    }
    assert.equal((await b.client.rpc('status')).knowledge.catalog.total, 0);
  });
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  const errors = [];
  for (const owner of [...owners].reverse()) { try { await stop(owner); } catch (error) { errors.push(error.message); } }
  for (const log of logs) closeSync(log);
  if (!errors.length) {
    for (const owner of owners) rmSync(owner.root, { recursive: true, force: true });
    for (const file of ['a-card.json', 'b-card.json', 'home']) rmSync(join(directory, file), { recursive: true, force: true });
  }
  report.cleanup = errors.length ? { ok: false, errors } : { ok: true, disposableInstancesRemoved: true };
  report.success = report.checks.every(check => check.status === 'passed') && report.cleanup.ok;
  report.finishedAt = new Date().toISOString();
  const path = join(directory, 'report.json'); writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ success: report.success, passed: report.checks.filter(check => check.status === 'passed').length, total: names.length, report: path, evidence: report.environment, liveModel: false, realTelegram: false }));
  if (!report.success) process.exitCode = 1;
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
