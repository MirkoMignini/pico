import { afterEach, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NODE_VERSION, PNPM_VERSION } from '../src/version.js';
import { initialize } from '../src/config.js';
import { serviceDefinition } from '../src/service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version = '1.2.3') {
  const root = mkdtempSync('/tmp/pikobot-install-'); roots.push(root);
  const source = join(root, 'reviewed source'), prefix = join(root, 'application prefix'), bin = join(root, 'tools');
  mkdirSync(source); mkdirSync(bin);
  for (const directory of ['scripts', 'src', 'migrations', 'patches', 'docs', 'examples']) mkdirSync(join(source, directory));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'pikobot', version, engines: { node: NODE_VERSION }, packageManager: `pnpm@${PNPM_VERSION}`, type: 'module' }));
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.node-version', 'README.md', 'LICENSE']) writeFileSync(join(source, name), name === '.node-version' ? NODE_VERSION : 'synthetic build input');
  writeFileSync(join(source, 'src', 'main.ts'), 'synthetic source');
  copyFileSync(new URL('../scripts/install.mjs', import.meta.url), join(source, 'scripts', 'install.mjs'));
  copyFileSync(new URL('../scripts/release.mjs', import.meta.url), join(source, 'scripts', 'release.mjs'));
  const manager = join(bin, 'pnpm');
  writeFileSync(manager, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){console.log('${PNPM_VERSION}');process.exit(0);}\nif(process.env.PIKOBOT_INSTALL_TEST_FAIL==='1')process.exit(17);\nif(args[0]==='install'&&(!args.includes('--frozen-lockfile')||!args.includes('--ignore-scripts')))process.exit(18);\nif(args[0]==='build'){fs.mkdirSync('dist');const pkg=JSON.parse(fs.readFileSync('package.json'));fs.writeFileSync('dist/cli.js','console.log('+JSON.stringify('Pikobot '+pkg.version)+');');}\n`, { mode: 0o700 });
  // No real dependency/registry access is performed by this synthetic package-manager fixture.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root };
  const install = (extra: string[] = [], overrides: Record<string, string> = {}) => spawnSync(process.execPath, [join(source, 'scripts', 'install.mjs'), '--source', source, '--prefix', prefix, ...extra], { encoding: 'utf8', env: { ...env, ...overrides }, timeout: 30_000 });
  const activate = (selected: string) => spawnSync(process.execPath, [join(source, 'scripts', 'install.mjs'), '--prefix', prefix, '--activate', selected], { encoding: 'utf8', env, timeout: 30_000 });
  return { root, source, prefix, install, activate, env };
}
it('installs immutable private versions, preserves owner separation and selects/rolls back without starting anything', () => {
  const s = fixture(); mkdirSync(join(s.source, '.instances')); writeFileSync(join(s.source, '.instances', 'private.json'), 'PRIVATE-INSTANCE-SENTINEL');
  writeFileSync(join(s.source, 'secrets.json'), 'PRIVATE-CREDENTIAL-SENTINEL');
  const first = s.install(); expect(first.status, first.stderr + first.stdout).toBe(0);
  expect(readlinkSync(join(s.prefix, 'current'))).toBe('releases/1.2.3');
  const release = join(s.prefix, 'releases', '1.2.3');
  expect(existsSync(join(release, '.instances'))).toBe(false); expect(existsSync(join(release, 'secrets.json'))).toBe(false); expect(existsSync(join(release, 'pikobot.sqlite'))).toBe(false);
  expect(lstatSync(release).mode & 0o777).toBe(0o700);
  const wrapper = join(s.prefix, 'bin', 'pikobot');
  const version = spawnSync(wrapper, ['--version'], { encoding: 'utf8', env: s.env }); expect(version.status, version.stderr).toBe(0); expect(version.stdout).toContain('Pikobot 1.2.3');
  expect(s.install().stderr).toContain('already installed');
  const pkg = JSON.parse(readFileSync(join(s.source, 'package.json'), 'utf8')); pkg.version = '1.2.4'; writeFileSync(join(s.source, 'package.json'), JSON.stringify(pkg));
  expect(s.install().status).toBe(0); expect(readlinkSync(join(s.prefix, 'current'))).toBe('releases/1.2.4');
  const rollback = spawnSync(process.execPath, [join(s.prefix, 'current', 'scripts', 'install.mjs'), '--prefix', realpathSync(s.prefix), '--activate', '1.2.3'], { encoding: 'utf8', env: s.env, timeout: 30_000 });
  expect(rollback.status, rollback.stderr).toBe(0); expect(readlinkSync(join(s.prefix, 'current'))).toBe('releases/1.2.3');
  const owner = join(s.root, 'owner'); initialize(owner, 'synthetic');
  const definition = serviceDefinition(owner, { home: s.root, platform: 'linux', cli: join(release, 'dist', 'cli.js') });
  expect(definition.content).toContain(join(realpathSync(s.prefix), 'bin', 'pikobot')); expect(definition.content).not.toContain(join(release, 'dist', 'cli.js'));
});
it('refuses source-overlapping prefixes, including aliases, without recursive copying', () => {
  const s = fixture(), alias = join(s.root, 'source-alias'); symlinkSync(s.source, alias);
  for (const prefix of [s.source, realpathSync(s.source), s.root, join(s.source, 'docs', 'application'), join(alias, 'examples', 'application')]) {
    const result = spawnSync(process.execPath, [join(s.source, 'scripts', 'install.mjs'), '--source', s.source, '--prefix', prefix], { encoding: 'utf8', env: s.env, timeout: 30_000 });
    expect(result.status, result.stderr).toBe(1); expect(result.stderr).toContain('separate application prefix');
    expect(result.stderr).not.toContain('ENAMETOOLONG');
  }
  expect(existsSync(join(s.source, 'docs', 'application'))).toBe(false);
  expect(existsSync(join(s.prefix, 'current'))).toBe(false);
});
it('preserves the previous selection after a failed build and never cleans someone else’s installer lock', () => {
  const s = fixture(); expect(s.install().status).toBe(0);
  const pkg = JSON.parse(readFileSync(join(s.source, 'package.json'), 'utf8')); pkg.version = '1.2.4'; writeFileSync(join(s.source, 'package.json'), JSON.stringify(pkg));
  const failed = s.install([], { PIKOBOT_INSTALL_TEST_FAIL: '1' }); expect(failed.status).toBe(1);
  expect(readlinkSync(join(s.prefix, 'current'))).toBe('releases/1.2.3'); expect(existsSync(join(s.prefix, 'releases', '1.2.4'))).toBe(false);
  expect(readdirSync(s.prefix).some(name => name.startsWith('.staging'))).toBe(false);
  mkdirSync(join(s.prefix, '.install-lock')); expect(s.install().status).toBe(1); expect(existsSync(join(s.prefix, '.install-lock'))).toBe(true);
});
it('refuses owner prefixes, altered launchers, symlinked source inputs and invalid activation versions', () => {
  const s = fixture(); mkdirSync(s.prefix); writeFileSync(join(s.prefix, 'config.json'), 'private owner');
  expect(s.install().stderr).toContain('never an owner instance'); expect(readFileSync(join(s.prefix, 'config.json'), 'utf8')).toBe('private owner'); rmSync(s.prefix, { recursive: true });
  const external = join(s.root, 'external'); writeFileSync(external, 'PRIVATE-SOURCE-SENTINEL'); symlinkSync(external, join(s.source, 'src', 'secret.ts'));
  expect(s.install().stderr).toContain('not symlinks'); rmSync(join(s.source, 'src', 'secret.ts'));
  expect(s.install().status).toBe(0); writeFileSync(join(s.prefix, 'bin', 'pikobot'), 'externally edited');
  expect(s.activate('1.2.3').stderr).toContain('refusing to overwrite'); expect(s.activate('../owner').stderr).toContain('Invalid version');
});
it('packages only a committed public snapshot with matching version, revision and archive checksum', () => {
  const s = fixture(), git = (...args: string[]) => execFileSync('git', ['-C', s.source, ...args], { env: { ...s.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'synthetic release'); git('tag', 'v1.2.3');
  const sha = git('rev-parse', 'HEAD').toString().trim();
  mkdirSync(join(s.source, '.instances')); writeFileSync(join(s.source, '.instances', 'owner.json'), 'PRIVATE-UNTRACKED-SENTINEL');
  writeFileSync(join(s.source, 'README.md'), 'uncommitted change');
  const output = join(s.root, 'release');
  const result = spawnSync(process.execPath, [join(s.source, 'scripts', 'release.mjs'), '--output', output, '--ref', 'v1.2.3'], { encoding: 'utf8', env: s.env });
  expect(result.status, result.stderr).toBe(0);
  const archive = join(output, 'pikobot-1.2.3-source.tar.gz'), digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toBe(`${digest}  pikobot-1.2.3-source.tar.gz\n`);
  expect(JSON.parse(readFileSync(join(output, 'release.json'), 'utf8'))).toMatchObject({ revision: sha, sha256: digest, version: '1.2.3' });
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }); expect(listing).toContain('pikobot-1.2.3/scripts/install.mjs'); expect(listing).not.toContain('.instances'); expect(listing).not.toContain('/.git/');
  expect(execFileSync('tar', ['-xOzf', archive, 'pikobot-1.2.3/README.md'], { encoding: 'utf8' })).toBe('synthetic build input');
  expect(spawnSync(process.execPath, [join(s.source, 'scripts', 'release.mjs'), '--output', output], { encoding: 'utf8', env: s.env }).status).toBe(1);
  git('tag', 'v9.9.9'); const denied = spawnSync(process.execPath, [join(s.source, 'scripts', 'release.mjs'), '--output', join(s.root, 'wrong'), '--ref', 'v9.9.9'], { encoding: 'utf8', env: s.env }); expect(denied.status).toBe(1); expect(denied.stderr).toContain('tag must match');
  writeFileSync(join(s.source, 'src', 'secrets.json'), 'PRIVATE-TRACKED-SENTINEL'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'synthetic forbidden path');
  const forbidden = spawnSync(process.execPath, [join(s.source, 'scripts', 'release.mjs'), '--output', join(s.root, 'forbidden')], { encoding: 'utf8', env: s.env }); expect(forbidden.status).toBe(1); expect(forbidden.stderr).toContain('Forbidden'); expect(existsSync(join(s.root, 'forbidden'))).toBe(false);
});
it('shows installer/release help without package-manager access or provisioning', () => {
  const s = fixture(); for (const file of ['install.mjs', 'release.mjs']) {
    const result = spawnSync(process.execPath, [join(s.source, 'scripts', file), '--help'], { encoding: 'utf8', env: { PATH: '' } }); expect(result.status, result.stderr).toBe(0); expect(existsSync(s.prefix)).toBe(false);
  }
});
