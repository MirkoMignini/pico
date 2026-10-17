import { spawn, execFileSync } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const instance = join(repo, '.instances', 'dev');
const state = join(repo, '.instances', 'workspace');
const script = fileURLToPath(import.meta.url);
let configFiles;
async function files() {
  configFiles ??= await import('../dist/config.js');
  configFiles.privateDirectory(join(repo, '.instances'));
  configFiles.privateDirectory(state);
  return configFiles;
}
async function save(name, value) { (await files()).atomicWrite(join(state, name), JSON.stringify(value)); }
async function load(name) {
  const path = join(state, name);
  return existsSync(path) ? JSON.parse((await files()).readPrivate(path)) : undefined;
}
function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }).replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16)}`) + '\n';
  appendFileSync(join(state, 'daemon.log'), line, { mode: 0o600 });
  process.stdout.write(line);
}
function launch(args, stdio = 'inherit') { return spawn(process.execPath, [script, ...args], { cwd: repo, stdio }); }
function exited(child) {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
}
async function run(command, args, capture = false) {
  const child = spawn(command, args, { cwd: repo, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (capture) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => appendFileSync(join(state, 'checks.log'), chunk, { mode: 0o600 }));
  const result = await exited(child);
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.code ?? result.signal}); see Checks.`);
}
async function build(capture = false) {
  await run('pnpm', ['check'], capture);
  await run('pnpm', ['build'], capture);
}
function inside() {
  if (process.env.HERDR_ENV !== '1' || process.env.HERDR_SESSION !== 'pico' || !process.env.HERDR_WORKSPACE_ID || !process.env.HERDR_PANE_ID) {
    throw new Error('Layout setup must run inside the pico Herdr session. From your terminal: pnpm dev:workspace');
  }
}
function herdr(...args) {
  inside();
  return new Promise((resolve, reject) => {
    const child = spawn('herdr', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => { try { code === 0 ? resolve(JSON.parse(output).result) : reject(new Error(error || 'Herdr command failed')); } catch (e) { reject(e); } });
  });
}
async function workspace() {
  if (process.env.HERDR_ENV === '1') throw new Error('Already inside Herdr: attach pico from an outer terminal, then run pnpm dev:up if needed.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run pnpm dev:workspace from an interactive outer terminal.');
  await build();
  const f = await files();
  f.atomicWrite(join(state, 'herdr.toml'), `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(join(repo, 'scripts', 'dev.sh'))}\nshell_mode = "non_login"\n[ui]\nwindow_title = "Pico dev: {tab}"\n`);
  const env = { ...process.env, HERDR_SESSION: 'pico' };
  delete env.HERDR_CONFIG_PATH;
  const running = () => {
    const status = JSON.parse(execFileSync('herdr', ['--session', 'pico', 'status', 'server', '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 5000 }));
    if (typeof status.running !== 'boolean') throw new Error('Invalid Herdr server status; refusing to attach.');
    return status.running;
  };
  // Only the server needs Pico's pane defaults; the client reads the shared global config directly.
  if (!running()) {
    const server = spawn('herdr', ['--session', 'pico', 'server'], { cwd: repo, detached: true, stdio: 'ignore',
      env: { ...env, HERDR_CONFIG_PATH: join(state, 'herdr.toml'), HERDR_STARTUP_CWD: repo } });
    await new Promise((resolve, reject) => { server.once('spawn', resolve); server.once('error', reject); });
    server.unref();
    const until = Date.now() + 15_000;
    while (!running()) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Herdr server exited during startup; inspect pico’s Herdr server log before retrying.');
      if (Date.now() >= until) throw new Error('Herdr startup timed out; the server may still start. Inspect pico’s Herdr server log before retrying.');
      await sleep(100);
    }
  }
  console.log('Opening pico with your global Herdr keys and UI. First launch provisions tabs automatically. Detach: Ctrl+b, then q.');
  // Attach-only mode cannot accidentally spawn a server with the client's global pane defaults.
  const child = spawn('herdr', ['--session', 'pico', 'client'], { cwd: repo, stdio: 'inherit', env });
  const result = await exited(child); process.exitCode = result.code ?? 1;
}
async function up() {
  inside();
  await files();
  const saved = await load('layout.json');
  if (saved && saved.workspaceId !== process.env.HERDR_WORKSPACE_ID) throw new Error('This repo already has a development layout in another workspace; use its tabs.');
  await build(true);
  const f = await files();
  if (!existsSync(join(instance, 'config.json'))) f.initialize(instance, 'Pico developer');
  else f.loadConfig(instance);
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!saved) {
    await herdr('workspace', 'rename', workspaceId, 'pico');
    await herdr('tab', 'rename', process.env.HERDR_TAB_ID, 'Pi');
  }
  const layout = saved ?? { workspaceId, piPane: process.env.HERDR_PANE_ID, panes: {} };
  // Record acknowledged IDs incrementally so a setup retry leaves those tabs alone.
  await save('layout.json', layout);
  for (const role of ['daemon', 'tui', 'logs', 'status', 'checks', 'shell']) {
    // shortcut: recorded closed tabs need manual reopening; reconcile live IDs if closing tabs becomes routine.
    if (layout.panes[role]) continue;
    const result = await herdr('tab', 'create', '--workspace', workspaceId, '--cwd', repo, '--label', role === 'tui' ? 'TUI' : role[0].toUpperCase() + role.slice(1), '--env', `PICO_DEV_ROLE=${role}`, '--no-focus');
    layout.panes[role] = result.root_pane.pane_id;
    await save('layout.json', layout);
  }
  console.log('Ready. Use /login and /model in Pico (not Pi) to configure this fresh instance.');
  return !saved;
}
async function client() {
  const { Client } = await import('../dist/client.js');
  const c = new Client(instance);
  // Development clients must never spawn an invisible, unsupervised daemon.
  c.ensureDaemon = async () => { await c.rpc('status'); };
  return c;
}
async function backend() {
  const { serve } = await import('../dist/daemon.js');
  const daemon = await serve(instance);
  let requests = 0;
  daemon.server.on('request', (request, response) => {
    if (request.method === 'GET' && request.url === '/events') return;
    requests++; response.once('close', () => { requests--; });
  });
  const ready = () => !requests && daemon.runtime.canApplySettings;
  daemon.runtime.events.on('output', event => {
    // Log lifecycle metadata, never conversation bodies, deltas, notifications or auth prompts.
    if (event.type !== 'delta') log('output', { type: event.type, runId: event.runId, conversationId: event.conversationId,
      ...(event.type === 'tool' ? { tool: event.data.tool, state: event.data.state, error: event.data.error } : {}),
      ...(event.type === 'settled' ? { status: event.data.status } : {}),
      ...(event.type === 'diagnostic' ? { component: event.data.component, error: event.data.error } : {}) });
  });
  let closing = false;
  async function stop() {
    if (closing) return; closing = true;
    daemon.server.close();
    await daemon.close(); process.exit(0);
  }
  process.on('message', message => {
    if (message.op === 'check') process.send?.({ id: message.id, ready: ready() });
    if (message.op === 'stop') {
      if (!ready()) process.send?.({ id: message.id, ready: false });
      else { process.send?.({ id: message.id, ready: true }); void stop(); }
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'disconnect']) process.on(signal, () => { void stop().catch(error => { console.error(error); process.exit(1); }); });
  process.send?.({ booted: true });
  log('daemon_ready', { pid: process.pid, instance, extensionsExecution: 'in-process', warning: 'Full OS-user access; no isolation.' });
}
async function daemon() {
  const f = await files();
  const { acquireLock } = await import('../dist/store.js');
  const unlock = acquireLock(f.privateDirectory(join(state, 'supervisor')));
  let child, done, booted = false, stopping = false;
  async function start() {
    booted = false;
    child = launch(['backend'], ['ignore', 'inherit', 'inherit', 'ipc']);
    done = exited(child);
    let timer;
    try {
      await Promise.race([
        new Promise(resolve => child.on('message', message => { if (message.booted) { booted = true; resolve(); } })),
        done.then(() => { throw new Error('Development daemon exited during startup; see Daemon.'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Development daemon startup timed out; see Daemon before retrying.')), 60_000); })
      ]);
    } finally { clearTimeout(timer); }
    await save('ready.json', { generation: randomUUID(), pid: child.pid });
  }
  async function ask(op) {
    if (!booted || !child.connected) throw new Error('Development daemon is not running; restart its tab.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Daemon control timed out; inspect before retrying.')); }, 5000);
      const receive = message => { if (message.id === id) { cleanup(); message.ready ? resolve() : reject(new Error('Refresh deferred: active/queued/background work, delivery or login. Wait, then retry.')); } };
      const cleanup = () => { clearTimeout(timer); child.off('message', receive); };
      child.on('message', receive); child.send({ id, op });
    });
  }
  async function idleTui() {
    const tui = await load('tui.json');
    if (tui && !tui.closed && (Date.now() - tui.at > 3000 || !tui.ready)) throw new Error('Refresh deferred: TUI draft/dialog/work or stale TUI. Finish it, /quit, or restart the TUI tab.');
  }
  async function shutdown() {
    stopping = true;
    child?.kill('SIGTERM'); await done;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown(); });
  try {
    let seen = (await load('request.json'))?.id;
    await start();
    const previous = await load('reply.json');
    if (seen && seen !== previous?.id) log('refresh_uncertain', { id: seen, warning: 'Prior unacknowledged request will not be replayed.' });
    while (!stopping && child.exitCode === null && child.signalCode === null) {
      const request = await load('request.json'), reply = await load('reply.json');
      if (request && request.id !== seen && request.id !== reply?.id) {
        seen = request.id;
        try {
          await idleTui(); await ask('check');
          log('refresh_build', { id: request.id }); await build(true);
          await idleTui(); await ask('stop');
          const stopped = await done;
          if (stopped.code !== 0) throw new Error('Daemon shutdown failed; no replacement started. Inspect Daemon before retrying.');
          if (stopping) break;
          await start();
          await save('reply.json', { id: request.id, ok: true });
          log('refresh_ready', { id: request.id, pid: child.pid });
        } catch (error) {
          await save('reply.json', { id: request.id, ok: false, error: error.message });
          log('refresh_failed', { id: request.id, error: error.message });
        }
      }
      await sleep(250);
    }
    if (!stopping) throw new Error('Development daemon exited; no automatic replay/restart. Inspect Daemon, then run pnpm dev:daemon in that tab.');
  } finally { await shutdown(); unlock(); }
}
async function refresh() {
  const f = await files();
  const { acquireLock } = await import('../dist/store.js');
  const unlock = acquireLock(f.privateDirectory(join(state, 'refresh')));
  try {
    const ready = await load('ready.json');
    const status = await (await client()).rpc('status');
    if (!ready || ready.pid !== status.pid) throw new Error('Only the workspace-managed development daemon can be refreshed.');
    const previous = await load('request.json'), reply = await load('reply.json');
    if (previous && previous.id !== reply?.id) throw new Error('An earlier refresh is unacknowledged; inspect Daemon and request/reply files before retrying.');
    const id = randomUUID(); await save('request.json', { id });
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const result = await load('reply.json');
      if (result?.id === id) {
        if (!result.ok) throw new Error(result.error);
        console.log('Rebuilt and restarted the development daemon. TUI follows when idle; Pi, logs and other tabs stay running. Ephemeral sessions are lost.'); return;
      }
      await sleep(250);
    }
    throw new Error('Refresh acknowledgment timed out. It may still finish; inspect Daemon before retrying.');
  } finally { unlock(); }
}
async function tuiWorker() {
  const c = await client();
  const { ChatUI } = await import('../dist/tui.js');
  const ui = new ChatUI(c);
  const generation = (await load('ready.json'))?.generation;
  await ui.start();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return; checking = true;
    try {
      await save('tui.json', { at: Date.now(), ready: ui.canRefresh, generation });
      if ((await load('ready.json'))?.generation !== generation && ui.canRefresh) { ui.close(); process.exit(75); }
    } finally { checking = false; }
  }, 500);
  timer.unref();
  process.once('SIGTERM', () => { ui.close(); process.exit(0); });
  process.on('exit', () => {
    // A closed TUI is not a refresh blocker, including after /quit.
    try { configFiles.atomicWrite(join(state, 'tui.json'), JSON.stringify({ at: Date.now(), closed: true, generation })); } catch {}
  });
}
async function tui() {
  let worker, stopping = false;
  process.once('SIGTERM', () => { stopping = true; worker?.kill('SIGTERM'); });
  while (!stopping) {
    try { await (await client()).rpc('status'); } catch { await sleep(500); continue; }
    if (stopping) return;
    worker = launch(['tui-worker']);
    const result = await exited(worker);
    if (result.code !== 75) { process.exitCode = result.code ?? 1; return; }
  }
}
async function status() {
  const { safeTerminal } = await import('../dist/tui.js');
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');
    try {
      const s = await (await client()).rpc('status');
      console.log(safeTerminal(JSON.stringify({ instance, pid: s.pid, model: s.model, activeRuns: s.activeRuns, extensionsExecution: s.extensionsExecution,
        channels: s.channels, indexingPending: s.indexingPending, extraction: s.extraction, deliveries: s.deliveries,
        knowledgeJobs: s.knowledge.jobs.length, generation: (await load('ready.json'))?.generation }, null, 2)));
    } catch (error) { console.log(safeTerminal(`Waiting for development daemon: ${error.message}`)); }
    await sleep(3000);
  }
}
async function pane() {
  const role = process.env.PICO_DEV_ROLE;
  if (!role && !(await load('layout.json'))) { if (await up()) await run('pi', []); return; }
  if (role === 'daemon') return daemon();
  if (role === 'tui') return tui();
  if (role === 'status') return status();
  if (role === 'logs' || role === 'checks') {
    const path = join(state, role === 'logs' ? 'daemon.log' : 'checks.log');
    appendFileSync(path, '', { mode: 0o600 }); return run('tail', ['-n', '100', '-F', path]);
  }
  console.log('Pico dev shell: pnpm dev:refresh · pnpm dev:verify · pnpm dev:status\nInstance: ' + instance + '\nUNSAFE NATIVE extensions: full OS-user access, no isolation.');
}
async function main() {
  if (process.version !== 'v24.21.0') throw new Error('Use scripts/dev.sh to select Node 24.21.0.');
  process.chdir(repo);
  const command = process.argv[2] || 'pane';
  if (command === 'workspace') return workspace();
  if (command === 'up') return up();
  await files();
  if (command === 'pane') return pane();
  if (command === 'daemon') return daemon();
  if (command === 'backend') return backend();
  if (command === 'refresh') return refresh();
  if (command === 'tui') return tui();
  if (command === 'tui-worker') return tuiWorker();
  if (command === 'status') return status();
  if (command === 'verify') { await build(true); await run('pnpm', ['test'], true); console.log('Check/build/test passed; see Checks. Run pnpm dev:refresh to apply the build.'); return; }
  throw new Error('Commands: workspace, up, daemon, refresh, tui, status, verify');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
