import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { initialize, atomicWrite } from '../src/config.js';
import { Client } from '../src/client.js';
import { waitFor } from './helpers.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0).reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM'); await done;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pikobot-dev-'))); roots.push(root);
  for (const dir of ['scripts', 'bin']) mkdirSync(join(root, dir));
  for (const script of ['dev.mjs', 'dev.sh']) copyFileSync(join(repo, 'scripts', script), join(root, 'scripts', script));
  for (const dir of ['dist', 'node_modules']) symlinkSync(join(repo, dir), join(root, dir));
  writeFileSync(join(root, 'bin', 'pnpm'), '#!/bin/sh\nif [ "$1" = build ] && [ -e .fail-build ]; then echo "fixture compile failure"; exit 1; fi\necho "fixture pnpm $*"\n', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'herdr'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
fs.appendFileSync('herdr-calls.jsonl',JSON.stringify(args)+'\\n');
const configPath=process.env.HERDR_CONFIG_PATH||path.join(process.env.XDG_CONFIG_HOME,'herdr','config.toml');
fs.appendFileSync('herdr-configs.jsonl',JSON.stringify({args,configPath,config:fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8'):null,startupCwd:process.env.HERDR_STARTUP_CWD})+'\\n');
if(args.includes('status')) {
  if(fs.existsSync('.fail-herdr-status')) { console.error('fixture status failure');process.exit(1); }
  console.log(JSON.stringify(fs.existsSync('.invalid-herdr-status')?{}:{running:fs.existsSync('herdr-ready')}));process.exit(0);
}
if(args.at(-1)==='server') { if(fs.existsSync('.fail-herdr-start')) process.exit(1);fs.writeFileSync('herdr-ready',''); }
if(args.at(-1)==='client'&&fs.existsSync('.fail-herdr-client')) process.exit(7);
const n=fs.readFileSync('herdr-calls.jsonl','utf8').trim().split('\\n').length;
console.log(JSON.stringify({result:{root_pane:{pane_id:'fixture:p'+n}}}));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, XDG_CONFIG_HOME: join(root, 'config'), HERDR_CONFIG_PATH: '', HERDR_ENV: '', HERDR_SESSION: '' };
  const state = join(root, '.instances', 'workspace'), instance = join(root, '.instances', 'dev');
  function start(command: string, extra: Record<string, string> = {}, terminal = false) {
    // Mock the outer terminal too; these tests never start a real Herdr server or client.
    const args = terminal ? ['--import', 'data:text/javascript,process.stdin.isTTY=true;process.stdout.isTTY=true'] : [];
    const child = spawn(process.execPath, [...args, join(root, 'scripts', 'dev.mjs'), command], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let output = '';
    child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
    const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
    return { child, done, output: () => output };
  }
  return { root, state, instance, start };
}

it('keeps unrelated Herdr spaces in their own directory without entering the Pikobot launcher', () => {
  const f = fixture(), other = join(f.root, 'forma'), shell = join(f.root, 'bin', 'fixture-shell');
  mkdirSync(other);
  writeFileSync(shell, '#!/bin/sh\nprintf "shell:%s\\n" "$PWD"\n', { mode: 0o755 });
  for (const args of [[], ['pane']]) {
    const result = spawnSync('/bin/bash', [join(f.root, 'scripts', 'dev.sh'), ...args], { cwd: other,
      env: { ...process.env, PATH: '/bin:/usr/bin', SHELL: shell, PIKOBOT_DEV_ROLE: '' }, encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`shell:${other}\n`);
    expect(existsSync(f.state)).toBe(false);
  }
});

it('still enters the Pikobot repository for its panes, explicit commands and assigned development roles', () => {
  const f = fixture(), other = join(f.root, 'forma'), shell = join(f.root, 'bin', 'fixture-shell');
  mkdirSync(other);
  writeFileSync(shell, '#!/bin/sh\nprintf "shell:%s\\n" "$PWD"\n', { mode: 0o755 });
  writeFileSync(join(f.root, 'bin', 'node'), '#!/bin/sh\nif [ "$1" = --version ]; then echo v24.21.0; else printf "node:%s:%s\\n" "$PWD" "$*"; fi\n', { mode: 0o755 });
  writeFileSync(join(f.root, 'bin', 'pnpm'), '#!/bin/sh\necho 11.2.2\n', { mode: 0o755 });
  for (const [cwd, args, role] of [[f.root, [], ''], [other, ['status'], ''], [other, [], 'daemon']] as const) {
    const result = spawnSync('/bin/bash', [join(f.root, 'scripts', 'dev.sh'), ...args], { cwd,
      env: { ...process.env, PATH: `${join(f.root, 'bin')}:/bin:/usr/bin`, SHELL: shell, PIKOBOT_DEV_ROLE: role }, encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`node:${f.root}:scripts/dev.mjs ${args[0] ?? 'pane'}\n`);
    if (!args.length) expect(result.stdout).toContain(`shell:${f.root}\n`);
  }
});

it('uses Pikobot defaults only for the server and reads the same global client config on every attach', async () => {
  const f = fixture(), globalPath = join(f.root, 'config', 'herdr', 'config.toml');
  mkdirSync(join(f.root, 'config', 'herdr'), { recursive: true });
  const globalConfig = '[theme]\nname = "catppuccin"\n[keys]\nnext_tab = "cmd+right"\n[ui.sidebar.agents]\nrows = [["state_icon", "workspace"]]\n';
  writeFileSync(globalPath, globalConfig);
  const result = await f.start('workspace', { HERDR_CONFIG_PATH: join(f.root, 'ignored.toml') }, true).done;
  expect(result.code).toBe(0);
  const calls = () => readFileSync(join(f.root, 'herdr-configs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const server = calls().find(call => call.args.join(' ') === '--session pikobot server');
  expect(server.configPath).toBe(join(f.state, 'herdr.toml'));
  expect(server.config).toContain(`default_shell = "${join(f.root, 'scripts', 'dev.sh')}"`);
  expect(server.config).toContain('shell_mode = "non_login"');
  expect(server.config).toContain('window_title = "Pikobot dev: {tab}"');
  expect(server.config).not.toContain('[keys]');
  expect(server.config).not.toContain('[theme]');
  expect(server.startupCwd).toBe(f.root);
  const client = calls().find(call => call.args.at(-1) === 'client');
  expect(client.args).toEqual(['--session', 'pikobot', 'client']);
  expect(client.configPath).toBe(globalPath); expect(client.config).toBe(globalConfig);
  expect(readFileSync(globalPath, 'utf8')).toBe(globalConfig);
  expect(statSync(join(f.state, 'herdr.toml')).mode & 0o777).toBe(0o600);
  expect(existsSync(join(f.instance, 'config.json'))).toBe(false);
  const updated = globalConfig.replace('cmd+right', 'cmd+left'); writeFileSync(globalPath, updated);
  expect((await f.start('workspace', {}, true).done).code).toBe(0);
  expect(calls().filter(call => call.args.join(' ') === '--session pikobot server')).toHaveLength(1);
  expect(calls().at(-1).config).toBe(updated);
  expect(readFileSync(globalPath, 'utf8')).toBe(updated);
});

it.each([
  ['.fail-herdr-start', 'Herdr server exited during startup'],
  ['.fail-herdr-status', 'fixture status failure'],
  ['.invalid-herdr-status', 'Invalid Herdr server status'],
])('does not attach or auto-start a global-config server after %s', async (flag, message) => {
  const f = fixture(); writeFileSync(join(f.root, flag), '');
  const result = await f.start('workspace', {}, true).done;
  expect(result.code).toBe(1); expect(result.output).toContain(message);
  const calls = readFileSync(join(f.root, 'herdr-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  expect(calls.every(args => args.at(-1) !== 'client' && args[0] === '--session' && args[1] === 'pikobot')).toBe(true);
});

it('preserves the Herdr client exit code without stopping the persistent server', async () => {
  const f = fixture(); writeFileSync(join(f.root, '.fail-herdr-client'), '');
  expect((await f.start('workspace', {}, true).done).code).toBe(7);
  expect(existsSync(join(f.root, 'herdr-ready'))).toBe(true);
  expect(readFileSync(join(f.root, 'herdr-calls.jsonl'), 'utf8')).not.toContain('stop');
});

it('refuses a noninteractive workspace launch before building or starting Herdr', async () => {
  const f = fixture(), result = await f.start('workspace').done;
  expect(result.code).toBe(1); expect(result.output).toContain('interactive outer terminal');
  expect(result.output).not.toContain('fixture pnpm');
  expect(existsSync(join(f.root, 'herdr-calls.jsonl'))).toBe(false);
});

it('refuses layout control outside Herdr and provisions explicit, no-focus tabs once with a mocked CLI', async () => {
  const f = fixture();
  const denied = await f.start('up').done;
  expect(denied.code).toBe(1); expect(denied.output).toContain('inside the pikobot Herdr session');
  expect(existsSync(join(f.root, 'herdr-calls.jsonl'))).toBe(false);
  const context = { HERDR_ENV: '1', HERDR_SESSION: 'pikobot', HERDR_WORKSPACE_ID: 'fixture', HERDR_PANE_ID: 'fixture:caller', HERDR_TAB_ID: 'fixture:tab' };
  const provisioned = await f.start('up', context).done; expect(provisioned).toMatchObject({ code: 0 });
  const calls = readFileSync(join(f.root, 'herdr-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  const tabs = calls.filter(args => args[0] === 'tab' && args[1] === 'create');
  expect(tabs).toHaveLength(6);
  expect(tabs.map(args => args[args.indexOf('--label') + 1])).toEqual(['Daemon', 'TUI', 'Logs', 'Status', 'Checks', 'Shell']);
  for (const args of tabs) { expect(args).toContain('--no-focus'); expect(args[args.indexOf('--workspace') + 1]).toBe('fixture'); }
  expect(statSync(f.instance).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.state, 'layout.json')).mode & 0o777).toBe(0o600);
  expect(existsSync(join(f.instance, 'credentials.json'))).toBe(false);
  const before = readFileSync(join(f.root, 'herdr-calls.jsonl'), 'utf8');
  expect((await f.start('up', context).done).code).toBe(0);
  expect(readFileSync(join(f.root, 'herdr-calls.jsonl'), 'utf8')).toBe(before);
});

it('can stop the TUI supervisor while it is waiting for an offline daemon', async () => {
  const f = fixture(); initialize(f.instance, 'Synthetic offline developer');
  const tui = f.start('tui'); await new Promise(resolve => setTimeout(resolve, 500));
  tui.child.kill('SIGTERM');
  expect((await tui.done).code).toBe(0);
}, 5000);

it('defers a pre-rename workspace refresh before requesting a build or stopping its backend', async () => {
  const f = fixture(); initialize(f.instance, 'Synthetic legacy developer');
  mkdirSync(f.state, { mode: 0o700 });
  atomicWrite(join(f.state, 'ready.json'), JSON.stringify({ pid: 123 }));
  writeFileSync(join(f.instance, 'legacy.sqlite'), 'synthetic legacy database');
  const server = createServer((_request, response) => response.end(JSON.stringify({ ok: true, result: { pid: 123 } })));
  await new Promise<void>(resolve => server.listen(join(f.instance, 'daemon.sock'), resolve));
  try {
    const result = await f.start('refresh').done;
    expect(result.code).toBe(1); expect(result.output).toContain('offline rename procedure');
    expect(existsSync(join(f.state, 'request.json'))).toBe(false);
    expect(existsSync(join(f.state, 'checks.log'))).toBe(false);
    expect(readFileSync(join(f.instance, 'legacy.sqlite'), 'utf8')).toBe('synthetic legacy database');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('refreshes only its managed child, preserves synthetic memory and fails safely on drafts, requests and compile errors', async () => {
  const f = fixture();
  const config = initialize(f.instance, 'Synthetic developer'); delete config.embeddings;
  atomicWrite(join(f.instance, 'config.json'), JSON.stringify(config));
  mkdirSync(f.state, { mode: 0o700 });
  atomicWrite(join(f.state, 'request.json'), JSON.stringify({ id: 'uncertain-fixture' }));
  const supervisor = f.start('daemon');
  await waitFor(() => existsSync(join(f.state, 'ready.json')), 30_000);
  const client = new Client(f.instance), status = await client.rpc<{ pid: number; ownerId: string; instanceId: string }>('status');
  await client.rpc('memory.remember', { key: 'fixture', value: 'synthetic-private-content' });
  const uncertain = await f.start('refresh').done;
  expect(uncertain.code).toBe(1); expect(uncertain.output).toContain('unacknowledged');
  expect(existsSync(join(f.state, 'reply.json'))).toBe(false); // No replay on supervisor startup.
  atomicWrite(join(f.state, 'reply.json'), JSON.stringify({ id: 'uncertain-fixture', ok: false, error: 'Fixture operator inspected the stale request' }));
  atomicWrite(join(f.state, 'tui.json'), JSON.stringify({ at: Date.now(), ready: false }));
  const draft = await f.start('refresh').done;
  expect(draft.code).toBe(1); expect(draft.output).toContain('TUI draft/dialog');
  expect((await client.rpc<{ pid: number }>('status')).pid).toBe(status.pid);
  atomicWrite(join(f.state, 'tui.json'), JSON.stringify({ at: 0, closed: true }));
  // Keep an authenticated RPC body incomplete: even work not in activeRuns must block refresh.
  const pending = request({ socketPath: client.socket, method: 'POST', path: '/rpc', headers: { Authorization: `Bearer ${client.token}` } });
  pending.on('error', () => {}); pending.write('{');
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const busy = await f.start('refresh').done;
    expect(busy.code).toBe(1); expect(busy.output).toContain('Refresh deferred');
  } finally { pending.destroy(); }
  await new Promise(resolve => setTimeout(resolve, 100));
  writeFileSync(join(f.root, '.fail-build'), '');
  const failed = await f.start('refresh').done;
  expect(failed.code).toBe(1); expect(failed.output).toContain('build failed');
  expect((await client.rpc<{ pid: number }>('status')).pid).toBe(status.pid);
  expect(readFileSync(join(f.state, 'checks.log'), 'utf8')).toContain('fixture compile failure');
  rmSync(join(f.root, '.fail-build'));
  const refreshed = await f.start('refresh').done; expect(refreshed).toMatchObject({ code: 0 });
  const next = await client.rpc<typeof status>('status'); expect(next.pid).not.toBe(status.pid);
  expect(next.ownerId).toBe(status.ownerId); expect(next.instanceId).toBe(status.instanceId);
  expect(JSON.stringify(await client.rpc('memory.list'))).toContain('synthetic-private-content');
  expect(readFileSync(join(f.state, 'daemon.log'), 'utf8')).not.toContain('synthetic-private-content');
  const actualReady = readFileSync(join(f.state, 'ready.json'), 'utf8');
  atomicWrite(join(f.state, 'ready.json'), JSON.stringify({ pid: -1 }));
  const foreign = await f.start('refresh').done; expect(foreign.code).toBe(1); expect(foreign.output).toContain('workspace-managed');
  atomicWrite(join(f.state, 'ready.json'), actualReady);
  supervisor.child.kill('SIGTERM'); await supervisor.done;
  const offline = await f.start('refresh').done; expect(offline.code).toBe(1);
  await expect(client.rpc('status')).rejects.toThrow(); // No hidden Client.ensureDaemon fallback.
}, 60_000);
