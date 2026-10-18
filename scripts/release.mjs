#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, output: { type: 'string' }, ref: { type: 'string' } }, strict: true });
  if (values.help) { console.log('Create a versioned Pico source archive and SHA256SUMS from an exact committed Git ref.\nnode scripts/release.mjs --output NEW_DIRECTORY [--ref HEAD|TAG|COMMIT]\nUncommitted changes, .git, instances, credentials and caches are not copied.\nNo publication, installation, inference or deployment occurs. Run CI before release.'); return; }
  if (!values.output) throw new Error('Use --output NEW_DIRECTORY; existing output directories are never overwritten');
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const git = args => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 20_000_000 });
  const revision = git(['rev-parse', '--verify', '--end-of-options', `${values.ref ?? 'HEAD'}^{commit}`]).toString().trim();
  const pkg = JSON.parse(git(['show', `${revision}:package.json`]).toString());
  if (pkg.name !== 'pico-assistant' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Selected commit is not a versioned Pico source tree');
  if (values.ref?.startsWith('v') && values.ref !== `v${pkg.version}`) throw new Error('Release tag must match package.json version exactly');
  const output = resolve(values.output); if (existsSync(output)) throw new Error('Output directory already exists');
  const allowed = ['.node-version', '.gitignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', 'src', 'migrations', 'patches', 'docs', 'examples', 'scripts', 'tests', 'eval', 'deploy', '.github'];
  const paths = git(['ls-tree', '-r', '--name-only', '-z', revision, '--', ...allowed]).toString().split('\0').filter(Boolean);
  if (!paths.includes('scripts/install.mjs')) throw new Error('Selected commit predates the versioned installer');
  if (paths.some(path => /(?:^|\/)(?:\.env(?:\..*)?|secrets\.json|credentials\.json|auth\.json|\.instances|node_modules|\.git)(?:\/|$)/.test(path) || /\.(?:pem|key|p12|sqlite|db)$/.test(path))) throw new Error('Forbidden private/build path is tracked in the release inputs');
  const modes = git(['ls-tree', '-r', revision, '--', ...allowed]).toString().split('\n').filter(Boolean);
  if (modes.some(line => !/^100(?:644|755) blob /.test(line))) throw new Error('Release inputs must be regular tracked files, not symlinks or submodules');
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const name = `pico-${pkg.version}-source.tar.gz`, archive = join(output, name);
  try {
    git(['archive', '--format=tar.gz', `--prefix=pico-${pkg.version}/`, `--output=${archive}`, revision, '--', ...paths]);
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(join(output, 'SHA256SUMS'), `${sha256}  ${name}\n`, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(output, 'release.json'), JSON.stringify({ version: pkg.version, revision, archive: name, sha256, kind: 'source', verification: 'Run check/build/tests and secret/dependency review separately; this command does not certify the build.' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ version: pkg.version, revision, archive, sha256, published: false }, null, 2));
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
}
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Release packaging failed'); process.exitCode = 1; }
