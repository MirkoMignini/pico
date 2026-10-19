#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const help = `Pikobot versioned source installer (macOS/Linux)\n\nnode scripts/install.mjs [--prefix PATH] [--source CHECKOUT_OR_EXTRACTED_RELEASE]\nnode scripts/install.mjs --prefix PATH --activate VERSION\n\nRequires the release's exact Node/pnpm versions. Installs frozen dependencies\nwith scripts disabled, checks/builds in a private version directory and atomically\nselects it. Does NOT initialize an owner, import credentials, install services,\nstart/restart daemons, modify shell profiles or remove older versions.\n--activate selects an already installed version; schema downgrades may be refused.\nDefault prefix: ~/.local/share/pikobot-app; add PREFIX/bin to PATH yourself.\n`;
const present = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
function ownedDirectory(path) {
  if (!present(path)) { mkdirSync(path, { recursive: true, mode: 0o700 }); }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Installation directories must be private, owned by this OS user and not symlinks');
  return realpathSync(path);
}
function copy(source, destination) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('Source build inputs must be regular files/directories, not symlinks or special files');
  if (stat.isDirectory()) { mkdirSync(destination, { mode: 0o700 }); for (const name of readdirSync(source)) copy(join(source, name), join(destination, name)); }
  else { copyFileSync(source, destination); chmodSync(destination, 0o600); }
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function command(cwd, name, args) {
  const result = spawnSync(name, args, { cwd, stdio: 'inherit', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` } });
  if (result.error || result.status !== 0) throw new Error('Installation command failed; the previously selected version has not been changed');
}
function manifest(path) {
  const value = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (value.name !== 'pikobot' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) || !/^\d+\.\d+\.\d+$/.test(value.engines?.node) || !/^pnpm@\d+\.\d+\.\d+$/.test(value.packageManager)) throw new Error('Not a valid versioned Pikobot source release');
  return value;
}
async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, prefix: { type: 'string' }, source: { type: 'string' }, activate: { type: 'string' } }, strict: true });
  if (values.help) { console.log(help); return; }
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Native installation supports macOS and Linux only');
  if (values.source && values.activate) throw new Error('Choose source installation or --activate, not both');
  if (values.activate && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(values.activate)) throw new Error('Invalid version');
  const source = realpathSync(resolve(values.source ?? fileURLToPath(new URL('../', import.meta.url))));
  const requestedPrefix = resolve(values.prefix ?? join(homedir(), '.local', 'share', 'pikobot-app'));
  let ancestor = requestedPrefix;
  while (!present(ancestor)) ancestor = dirname(ancestor);
  const destination = resolve(realpathSync(ancestor), relative(ancestor, requestedPrefix));
  const overlapsSource = source === destination || source.startsWith(`${destination}/`) || destination.startsWith(`${source}/`);
  if (/[\x00-\x1f\x7f]/.test(requestedPrefix) || existsSync(join(destination, 'config.json')) || !values.activate && overlapsSource) throw new Error('Use a separate application prefix, never an owner instance or overlapping source tree');
  const pkg = manifest(values.activate ? join(requestedPrefix, 'releases', values.activate) : source);
  if (process.versions.node !== pkg.engines.node) throw new Error(`Select Node ${pkg.engines.node} first; no runtime is installed or replaced automatically`);
  const expectedPnpm = pkg.packageManager.replace('pnpm@', '');
  if (!values.activate) {
    const result = spawnSync('pnpm', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
    if (result.status !== 0 || result.stdout.trim() !== expectedPnpm) throw new Error(`Select pnpm ${expectedPnpm} first`);
  }
  const prefix = ownedDirectory(requestedPrefix), releases = ownedDirectory(join(prefix, 'releases')), bin = ownedDirectory(join(prefix, 'bin'));
  const lock = join(prefix, '.install-lock'); mkdirSync(lock, { mode: 0o700 });
  let stage;
  try {
    const current = join(prefix, 'current'), currentStat = present(current);
    if (currentStat && (!currentStat.isSymbolicLink() || !realpathSync(current).startsWith(`${releases}/`))) throw new Error('Current selection is not a managed release symlink; refusing to replace it');
    const wrapper = `#!/bin/sh\nset -eu\nexec /bin/sh ${quote(join(prefix, 'current', 'launch'))} "$@"\n`;
    const executable = join(bin, 'pikobot'), existing = present(executable);
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid?.() || readFileSync(executable, 'utf8') !== wrapper)) throw new Error('Existing launcher is not the managed Pikobot wrapper; refusing to overwrite it');
    const release = join(releases, pkg.version);
    if (values.activate) {
      ownedDirectory(release);
      const receipt = JSON.parse(readFileSync(join(release, 'installation.json'), 'utf8'));
      if (receipt.prefix !== prefix || receipt.releaseVersion !== pkg.version || !existsSync(join(release, 'dist', 'cli.js'))) throw new Error('Selected version is not a completed installation for this prefix');
    } else {
      if (present(release)) throw new Error('This version is already installed. Use --activate to select it; do not overwrite immutable versions');
      stage = join(prefix, `.staging-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
      for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.node-version', 'README.md', 'LICENSE', 'src', 'migrations', 'patches', 'docs', 'examples']) copy(join(source, file), join(stage, file));
      mkdirSync(join(stage, 'scripts'), { mode: 0o700 }); copy(join(source, 'scripts', 'install.mjs'), join(stage, 'scripts', 'install.mjs'));
      command(stage, 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']);
      command(stage, 'pnpm', ['check']); command(stage, 'pnpm', ['build']);
      command(stage, 'pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts']);
      command(stage, process.execPath, ['dist/cli.js', '--version']);
      writeFileSync(join(stage, 'installation.json'), JSON.stringify({ version: 1, prefix, releaseVersion: pkg.version, node: process.execPath }), { mode: 0o600, flag: 'wx' });
      writeFileSync(join(stage, 'launch'), `#!/bin/sh\nset -eu\nexec ${quote(process.execPath)} ${quote(join(release, 'dist', 'cli.js'))} "$@"\n`, { mode: 0o700, flag: 'wx' });
      renameSync(stage, release); stage = undefined;
    }
    if (!existing) writeFileSync(executable, wrapper, { mode: 0o700, flag: 'wx' });
    const selection = join(prefix, `.current-${randomUUID()}`);
    try { symlinkSync(join('releases', pkg.version), selection); renameSync(selection, current); }
    finally { if (present(selection)) rmSync(selection); }
    console.log(JSON.stringify({ installed: true, version: pkg.version, executable, selected: true, runningDaemonsRestarted: false, next: 'Use pikobot --help, initialize a NEW owner once, then chat and /setup. Existing owners: back up and explicitly restart their service when idle.' }, null, 2));
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); rmdirSync(lock); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Installation failed'); process.exitCode = 1; });
