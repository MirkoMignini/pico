import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc, serve } from '../src/daemon.js';
import { Runtime } from '../src/runtime.js';
import { atomicWrite } from '../src/config.js';
import { setup } from './helpers.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/mcp-browser-server.mjs', import.meta.url));
const directories: string[] = [];
const cli = (args: string[], input = '') => new Promise<string>((resolve, reject) => {
  const child = execFile(process.execPath, [cliPath, ...args], { timeout: 15_000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
  child.stdin!.end(input);
});
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('keeps bridge help inert and initializes/pairs from private stdin without starting an owner daemon or disclosing extension tokens', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pico-bridge-cli-')); directories.push(parent);
  const root = join(parent, 'bridge');
  expect(await cli(['browser-bridge', 'help', '--bridge-root', root])).toContain('private SSH tunnel');
  expect(existsSync(root)).toBe(false);
  const token = 'synthetic-local-extension-token';
  await expect(cli(['browser-bridge', 'init', fixture, 'never-inline-this-token', '--profile', 'Default', '--bridge-root', root])).rejects.toThrow('never arguments');
  expect(existsSync(root)).toBe(false);
  const result = await cli(['browser-bridge', 'init', fixture, '--profile', 'Profile 2', '--bridge-root', root], token);
  expect(JSON.parse(result)).toMatchObject({ initialized: true, profile: 'Profile 2', port: 8931 });
  expect(result).not.toContain(token);
  expect(readdirSync(root).sort()).toEqual(['.initialized', 'bridge.json', 'secrets.json']);
  const pairing = JSON.parse(await cli(['browser-bridge', 'pair', 'http://127.0.0.1:8931/mcp', '--bridge-root', root]));
  expect(pairing).toMatchObject({ version: 1, bridgeId: JSON.parse(result).bridgeId, url: 'http://127.0.0.1:8931/mcp' });
  expect(pairing.token).toHaveLength(43); expect(JSON.stringify(pairing)).not.toContain(token);
  const code = `Object.defineProperty(process.stdout,'isTTY',{value:true});process.argv=[process.execPath,${JSON.stringify(cliPath)},'browser-bridge','pair','http://127.0.0.1:8931/mcp','--bridge-root',${JSON.stringify(root)}];await import(${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)});`;
  const wrapper = join(parent, 'tty-check.mjs'); writeFileSync(wrapper, code, { mode: 0o600 });
  await new Promise<void>((resolve, reject) => execFile(process.execPath, [wrapper], { timeout: 15_000, env: { ...process.env, HOME: parent } }, (error, stdout, stderr) => {
    try { expect(error).not.toBeNull(); expect(stdout).toBe(''); expect(stderr).toContain('Pairing contains a credential'); expect(stderr).not.toContain(pairing.token); resolve(); } catch (failure) { reject(failure); }
  }));
}, 45_000);

it('imports a pairing through compiled CLI/Unix IPC, preserving unrelated settings and keeping its token in the vault', async () => {
  const s = setup('bridge-server-cli'); atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  const service = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models) });
  const pairing = { version: 1, bridgeId: crypto.randomUUID(), url: 'http://127.0.0.1:8931/mcp', token: 'x'.repeat(43) };
  try {
    await rpc(service.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ id: 'other', enabled: false, transport: 'stdio', command: '/usr/bin/false' }] } } });
    const result = await cli(['--instance', s.root, 'mcp', 'browser-remote', '-'], JSON.stringify(pairing));
    expect(JSON.parse(result)).toMatchObject({ saved: true }); expect(result).not.toContain(pairing.token);
    expect(await service.runtime.credentials.secret('extensions.mcp.browser-remote')).toContain(`Bearer ${pairing.token}`);
    const status = JSON.parse(await cli(['--instance', s.root, 'mcp', 'status']));
    expect(status.servers[0].id).toBe('other');
    expect(status.servers.find((server: any) => server.id === 'browser-remote')).toMatchObject({ state: 'not_connected' });
    await expect(cli(['--instance', s.root, 'mcp', 'browser-remote', '-'], 'never-print-this-private-text')).rejects.toThrow('Invalid browser bridge pairing JSON');
    expect(s.faux.state.callCount).toBe(0);
  } finally { await service.close(); await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
}, 45_000);
