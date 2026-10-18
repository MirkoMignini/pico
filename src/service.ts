import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { atomicWrite, loadConfig, privateDirectory, readPrivate } from './config.js';
import { object, validate } from './contracts.js';
import { Client } from './client.js';
import { hash } from './store.js';
import { NODE_VERSION } from './version.js';

export type ServiceAction = 'install' | 'status' | 'start' | 'stop' | 'restart' | 'uninstall';
type Run = (command: string, args: string[]) => Promise<{ stdout: string }>;
interface Options { home?: string; platform?: string; node?: string; cli?: string; run?: Run; confirmStop?: boolean }
interface Definition { file: string; label: string; target: string; content: string; platform: string; root: string }
const registrationSchema = object({ version: Type.Literal(1), platform: Type.String(), file: Type.String(), label: Type.String(), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }) });
const execute = promisify(execFile);
const run: Run = async (command, args) => {
  try { return await execute(command, args, { timeout: 20_000, maxBuffer: 100_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, LANG: 'C.UTF-8' } }); }
  catch { throw new Error('Service manager command failed or timed out; outcome may be uncertain. Inspect service status before repeating it. Definition files may already be installed.'); }
};
function safePath(path: string): string {
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Service paths must be absolute and contain no control characters');
  return path;
}
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const unit = (value: string, expand = false) => `"${(expand ? value.replaceAll('$', () => '$$') : value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
export function serviceDefinition(instance: string, options: Options = {}): Definition {
  const { root, config } = loadConfig(instance), platform = options.platform ?? process.platform;
  const home = safePath(resolve(options.home ?? homedir())), node = safePath(options.node ?? process.execPath);
  const entrypoint = options.cli ?? fileURLToPath(new URL('./cli.js', import.meta.url)), cli = safePath(existsSync(entrypoint) ? realpathSync(entrypoint) : entrypoint);
  safePath(root);
  const suffix = hash(config.instanceId).slice(0, 20), label = platform === 'darwin' ? `ai.pico.${suffix}` : `pico-${suffix}.service`;
  let command = [node, cli];
  const release = dirname(dirname(cli)), receipt = join(release, 'installation.json');
  if (existsSync(receipt)) {
    const data = JSON.parse(readPrivate(receipt)) as { prefix?: string };
    const manifest = JSON.parse(readFileSync(join(release, 'package.json'), 'utf8')) as { version: string };
    if (typeof data.prefix !== 'string' || release !== join(data.prefix, 'releases', manifest.version)) throw new Error('Invalid managed installation receipt');
    command = [safePath(join(data.prefix, 'bin', 'pico'))];
  }
  command.push('--instance', root, 'serve');
  const path = `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  if (platform === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', label);
    return { root, platform, label, target: label, file, content: `[Unit]\nDescription=Pico personal assistant\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n[Service]\nType=simple\nExecStart=${command.map(value => unit(value, true)).join(' ')}\nWorkingDirectory=${unit(root)}\nEnvironment=${unit(`HOME=${home}`)} ${unit(`PATH=${path}`)}\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\nSendSIGKILL=no\n\n[Install]\nWantedBy=default.target\n` };
  }
  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${label}.plist`), logs = join(root, 'service-logs');
    return { root, platform, label, target: `gui/${process.getuid?.()}/${label}`, file, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${command.map(value => `<string>${xml(value)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(path)}</string></dict>\n<key>Umask</key><integer>63</integer>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(join(logs, 'stdout.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(logs, 'stderr.log'))}</string>\n</dict></plist>\n` };
  }
  throw new Error('Per-user services support macOS launchd and Linux systemd only');
}
function registration(definition: Definition) {
  const path = join(definition.root, 'service.json');
  if (!existsSync(path)) return undefined;
  const value = validate<StaticRegistration>(registrationSchema, JSON.parse(readPrivate(path)));
  if (value.file !== definition.file || value.label !== definition.label || value.platform !== definition.platform) throw new Error('Service registration belongs to another platform/home; inspect it before changing services');
  if (hash(readPrivate(value.file)) !== value.digest) throw new Error('Service definition changed outside Pico; inspect it before changing services');
  return value;
}
type StaticRegistration = { version: 1; platform: string; file: string; label: string; digest: string };
function ownedDirectories(path: string, home: string): void {
  if (path !== home) {
    if (!path.startsWith(`${home}/`)) throw new Error('Service directory must be inside the selected home');
    ownedDirectories(dirname(path), home);
  }
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('Service directory must be owned by this OS user and not a symlink');
}
async function state(definition: Definition, runner: Run) {
  if (definition.platform === 'linux') {
    const result = await runner('systemctl', ['--user', 'show', definition.label, '--property=LoadState,ActiveState,SubState,MainPID']);
    const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=', 2)));
    return { loaded: fields.LoadState === 'loaded', running: fields.ActiveState === 'active', pid: Number(fields.MainPID) || 0 };
  }
  // launchctl print exits nonzero for an unloaded job; list is a successful, bounded inventory query.
  const result = await runner('/bin/launchctl', ['list']);
  const row = result.stdout.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[2] === definition.label);
  return { loaded: !!row, running: !!row && /^\d+$/.test(row[0]!), pid: row && /^\d+$/.test(row[0]!) ? Number(row[0]) : 0 };
}
async function reachable(root: string): Promise<boolean> {
  if (!existsSync(join(root, 'daemon.sock'))) return false;
  try { await new Client(root).rpc('health', {}, 3000); return true; }
  catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw new Error('Daemon health is unavailable or incompatible; inspect doctor before service changes. No daemon was started or stopped.'); }
}
async function stop(definition: Definition, runner: Run): Promise<void> {
  if (await reachable(definition.root)) {
    await new Client(definition.root).rpc('daemon.stop', { confirmEphemeral: true }, 5000);
    const until = Date.now() + 30_000;
    while (existsSync(join(definition.root, 'daemon.sock'))) {
      if (Date.now() > until) throw new Error('Graceful stop acknowledgment received, but shutdown is unfinished. Inspect status; no replacement was started.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } else if ((await state(definition, runner)).pid) throw new Error('A service process exists without health readiness. Inspect private startup logs; it will not be forcibly stopped.');
  const current = await state(definition, runner);
  if (definition.platform === 'linux') await runner('systemctl', ['--user', 'stop', definition.label]);
  else if (current.loaded) await runner('/bin/launchctl', ['bootout', definition.target]);
}
export async function manageService(instance: string, action: ServiceAction, options: Options = {}): Promise<unknown> {
  const definition = serviceDefinition(instance, options), runner = options.run ?? run;
  if (action !== 'status' && process.versions.node !== NODE_VERSION) throw new Error(`Use Node ${NODE_VERSION} before changing services`);
  if (['stop', 'restart', 'uninstall'].includes(action) && !options.confirmStop) throw new Error('Use --confirm-stop after closing TUI clients and finishing work. Ephemeral sessions are lost; accepted effects cannot be undone.');
  const saved = registration(definition);
  if (action === 'install') {
    if (saved && saved.digest !== hash(definition.content)) throw new Error('An existing service uses a different command. Stop/uninstall it explicitly before reinstalling; do not overwrite it live.');
    if (!saved && existsSync(definition.file)) throw new Error('Service definition already exists without a matching registration; refusing to overwrite it');
    ownedDirectories(dirname(definition.file), resolve(options.home ?? homedir()));
    if (definition.platform === 'darwin') {
      const logs = privateDirectory(join(definition.root, 'service-logs'));
      for (const name of ['stdout.log', 'stderr.log']) {
        const file = join(logs, name);
        if (existsSync(file)) readPrivate(file); else appendFileSync(file, '', { mode: 0o600, flag: 'ax' });
      }
    }
    if (!saved) {
      writeFileSync(definition.file, definition.content, { mode: 0o600, flag: 'wx' });
      atomicWrite(join(definition.root, 'service.json'), JSON.stringify({ version: 1, platform: definition.platform, file: definition.file, label: definition.label, digest: hash(definition.content) }));
    }
    if (definition.platform === 'linux') { await runner('systemctl', ['--user', 'daemon-reload']); await runner('systemctl', ['--user', 'enable', definition.label]); }
    return { installed: true, started: false, label: definition.label, note: 'Per-user service enabled for future logins. Start explicitly with service start; installation never restarts an existing daemon.' };
  }
  if (action === 'status') return { installed: !!saved, ...(saved ? await state(definition, runner) : { loaded: false, running: false }), daemonReachable: await reachable(definition.root), note: 'No daemon is started. OS service state and authenticated daemon readiness are separate.' };
  if (!saved) throw new Error('No Pico-managed service installed for this instance; use service install first');
  if (action === 'stop' || action === 'restart' || action === 'uninstall') await stop(definition, runner);
  if (action === 'uninstall') {
    if (definition.platform === 'linux') await runner('systemctl', ['--user', 'disable', definition.label]);
    unlinkSync(definition.file); unlinkSync(join(definition.root, 'service.json'));
    if (definition.platform === 'linux') await runner('systemctl', ['--user', 'daemon-reload']);
    return { uninstalled: true, ownerDataRemoved: false };
  }
  if (action === 'stop') return { stopped: true, ownerDataRemoved: false };
  if (await reachable(definition.root)) throw new Error('A daemon already owns this instance; do not start a second one. Inspect service status, then explicitly stop it first.');
  const current = await state(definition, runner);
  if (current.pid) throw new Error('A service is already starting or unhealthy; inspect doctor/private logs instead of starting another');
  if (definition.platform === 'linux') await runner('systemctl', ['--user', 'start', definition.label]);
  else if (current.loaded) await runner('/bin/launchctl', ['kickstart', definition.target]);
  else await runner('/bin/launchctl', ['bootstrap', `gui/${process.getuid?.()}`, definition.file]);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (await reachable(definition.root)) return { started: true, ready: true, note: 'Authenticated daemon health responded, not live provider/connector verification.' };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Service start readiness timed out; outcome is uncertain. Inspect service status and private logs before retrying.');
}
