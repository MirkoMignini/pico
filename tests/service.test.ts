import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '../src/client.js';
import { atomicWrite, initialize } from '../src/config.js';
import { serve } from '../src/daemon.js';
import { Runtime } from '../src/runtime.js';
import { manageService, serviceDefinition } from '../src/service.js';
import { setup, waitFor } from './helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function files() {
  const home = mkdtempSync('/tmp/pikobot-service-home-'), root = join(home, 'owner space $x %u & "quote"'); initialize(root, 'synthetic');
  cleanup.push(() => rmSync(home, { recursive: true, force: true })); return { home, root };
}
function manager() {
  return vi.fn(async (_command: string, args: string[]) => ({ stdout: args.includes('show') ? 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n' : 'PID Status Label\n' }));
}
it('renders owner-scoped systemd/launchd definitions without shell interpolation or ambient credentials', () => {
  const { home, root } = files();
  const linux = serviceDefinition(root, { home, platform: 'linux', node: '/node path/$x%u', cli: '/code path/cli.js' });
  expect(linux.content).toContain('"/node path/$$x%%u"'); expect(linux.content).toContain('WorkingDirectory=');
  expect(linux.content).toContain('SendSIGKILL=no'); expect(linux.content).toContain('Restart=on-failure'); expect(linux.content).not.toContain('API_KEY');
  const mac = serviceDefinition(root, { home, platform: 'darwin' });
  expect(mac.content).toContain('&amp;'); expect(mac.content).toContain('&quot;'); expect(mac.content).toContain('<integer>63</integer>'); expect(mac.label).not.toContain('synthetic');
  expect(serviceDefinition(root, { home, platform: 'linux' }).label).toBe(linux.label);
  expect(() => serviceDefinition(root, { home, platform: 'win32' })).toThrow('macOS launchd and Linux systemd');
  expect(() => serviceDefinition(root, { home, node: '/invalid\nnode' })).toThrow('control characters');
});
it.each(['linux', 'darwin'])('installs an explicit private %s service without starting a daemon or deleting owner data', async platform => {
  const { home, root } = files(), run = manager(), options = { home, platform, run };
  const result = await manageService(root, 'install', options); expect(result).toMatchObject({ installed: true, started: false });
  const definition = serviceDefinition(root, options); expect(lstatSync(definition.file).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(root, 'service.json')).mode & 0o777).toBe(0o600); expect(existsSync(join(root, 'pikobot.sqlite'))).toBe(false);
  expect(run.mock.calls.some(([, args]) => args.includes('start') || args.includes('bootstrap'))).toBe(false);
  expect(await manageService(root, 'install', options)).toMatchObject({ installed: true });
  expect(await manageService(root, 'status', options)).toMatchObject({ installed: true, daemonReachable: false });
  await expect(new Client(root).ensureDaemon()).rejects.toThrow('detached replacement will not be spawned');
  await expect(manageService(root, 'restart', options)).rejects.toThrow('--confirm-stop');
  expect(await manageService(root, 'uninstall', { ...options, confirmStop: true })).toMatchObject({ uninstalled: true, ownerDataRemoved: false });
  expect(existsSync(definition.file)).toBe(false); expect(existsSync(join(root, 'service.json'))).toBe(false); expect(existsSync(join(root, 'config.json'))).toBe(true);
});
it('checks existing service-log permissions without loading large private logs', async () => {
  const { home, root } = files(), options = { home, platform: 'darwin', run: manager() };
  await manageService(root, 'install', options);
  const log = join(root, 'service-logs', 'stdout.log'); truncateSync(log, 2 ** 31);
  expect(await manageService(root, 'install', options)).toMatchObject({ installed: true, started: false });
  expect(lstatSync(log).size).toBe(2 ** 31);
  chmodSync(log, 0o644);
  await expect(manageService(root, 'install', options)).rejects.toThrow('Unsafe permissions');
});
it('refuses modified/unregistered definitions and symlinked service directories without overwriting them', async () => {
  const { home, root } = files(), options = { home, platform: 'linux', run: manager() }, definition = serviceDefinition(root, options);
  mkdirSync(join(home, '.config'), { mode: 0o700 }); const outside = join(home, 'outside'); mkdirSync(outside); symlinkSync(outside, join(home, '.config', 'systemd'));
  await expect(manageService(root, 'install', options)).rejects.toThrow('not a symlink'); expect(existsSync(join(outside, 'user'))).toBe(false);
  rmSync(join(home, '.config', 'systemd')); await manageService(root, 'install', options);
  writeFileSync(definition.file, 'externally modified service', { mode: 0o600 });
  await expect(manageService(root, 'uninstall', { ...options, confirmStop: true })).rejects.toThrow('changed outside Pikobot'); expect(readFileSync(definition.file, 'utf8')).toBe('externally modified service');
});
it('leaves a failed manager operation inspectable rather than claiming installation or replaying it', async () => {
  const { home, root } = files(), run = vi.fn(async () => { throw new Error('synthetic manager unavailable'); });
  await expect(manageService(root, 'install', { home, platform: 'linux', run })).rejects.toThrow('synthetic manager unavailable');
  expect(run).toHaveBeenCalledOnce(); expect(existsSync(join(root, 'service.json'))).toBe(true); expect(existsSync(join(root, 'pikobot.sqlite'))).toBe(false);
});
it('refuses stopping busy work, live TUI/event clients and unconfirmed ephemeral sessions before closing anything', async () => {
  const s = setup(); atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  cleanup.push(async () => { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  const service = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models) }); cleanup.push(service.close);
  const client = new Client(s.root), busy = vi.spyOn(service.runtime, 'canApplySettings', 'get').mockReturnValue(false);
  await expect(client.rpc('daemon.stop')).rejects.toThrow('Stop refused'); busy.mockRestore();
  let connected = false; const unsubscribe = client.subscribe(() => {}, () => {}, () => { connected = true; }); cleanup.push(unsubscribe);
  await waitFor(() => connected); await expect(client.rpc('daemon.stop', { confirmEphemeral: true })).rejects.toThrow('close all TUI/event clients');
  unsubscribe(); await new Promise(resolve => setTimeout(resolve, 30));
  service.runtime.newConversation('synthetic volatile', true);
  await expect(client.rpc('daemon.stop')).rejects.toThrow('ephemeral sessions');
  expect(await client.rpc('health')).toMatchObject({ ephemeralSessions: 1 });
  expect(await client.rpc('daemon.stop', { confirmEphemeral: true })).toMatchObject({ stopping: true }); await service.done;
  expect(existsSync(join(s.root, 'daemon.sock'))).toBe(false); expect(existsSync(join(s.root, 'pikobot.sqlite'))).toBe(true);
});
