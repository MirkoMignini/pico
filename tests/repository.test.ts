import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
function markdown(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdown(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}
const prose = (path: string) => readFileSync(path, 'utf8').replace(/```[\s\S]*?```/g, '');
function anchors(path: string): Set<string> {
  const result = new Set<string>();
  for (const heading of prose(path).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = heading[1]!.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    let slug = base, duplicate = 0;
    while (result.has(slug)) slug = `${base}-${++duplicate}`;
    result.add(slug);
  }
  return result;
}

it('keeps public documentation links, images and local heading anchors valid', () => {
  const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'eval/GRADING.md'].map(path => join(root, path));
  for (const file of [...files, ...markdown(join(root, 'docs')), ...markdown(join(root, '.github'))]) {
    const content = prose(file);
    const links = [...content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(match => match[1]!);
    links.push(...[...content.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]!));
    for (const link of links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue;
      const [path, fragment] = link.split('#'), target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      expect(existsSync(target), `${file}: ${link}`).toBe(true);
      if (fragment && target.endsWith('.md')) expect(anchors(target).has(decodeURIComponent(fragment)), `${file}: ${link}`).toBe(true);
    }
  }
});

it('ignores accidental secrets and instance data without hiding synthetic fixtures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pico-ignore-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  try {
    const initialized = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8', env });
    expect(initialized.status, initialized.stderr).toBe(0);
    writeFileSync(join(directory, '.gitignore'), readFileSync(join(root, '.gitignore')));
    const ignored = ['.env', '.env.local', 'nested/.env.production', 'notes.db', 'notes.db-wal', 'pico.sqlite', 'pico.sqlite-shm', 'notes.sqlite3', 'client.pem', 'account.key', 'client.p12', 'credentials.json', 'nested/vault.json', 'backups/owner.json', '.instances/dev/config.json', 'eval/live-run.json', 'eval/knowledge-live-first-failed.json', 'eval/mem0-final-results.json'];
    const visible = ['.env.example', 'nested/.env.example', 'tests/fixtures/knowledge/manifest.json', 'eval/daily-assistant.json', 'eval/daily-assistant-gold.json', 'eval/mem0-validation.json', 'docs/SECURITY.md', 'src/credentials.ts'];
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: directory, env, encoding: 'utf8', input: [...ignored, ...visible].join('\n') + '\n' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(ignored);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps public CI credential-free, pinned and ordered with one explicit audit exception', () => {
  const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  expect(workflow.on).toHaveProperty('pull_request');
  expect(workflow.on).not.toHaveProperty('pull_request_target');
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.verify.strategy.matrix.os).toEqual(['ubuntu-24.04', 'macos-15']);
  const steps = workflow.jobs.verify.steps;
  expect(steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/setup-node@')).with['node-version-file']).toBe('.node-version');
  expect(steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run)).toEqual([
    'pnpm install --frozen-lockfile --ignore-scripts', 'pnpm check', 'pnpm build', 'pnpm test',
    'pnpm audit --prod --audit-level high --ignore GHSA-vfj7-8cjw-p6xm',
  ]);
  for (const job of Object.values(workflow.jobs) as { steps: { uses?: string; with?: Record<string, unknown> }[] }[]) {
    for (const step of job.steps.filter(step => step.uses)) {
      expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      if (step.uses!.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
    }
  }
  const scan = workflow.jobs.secrets.steps;
  expect(scan[0].with['fetch-depth']).toBe(0);
  expect(scan.at(-1).run).toContain('--redact');
  expect(scan.at(-1).run).toContain('--log-opts="--all"');
  expect(parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).auditConfig).toBeUndefined();
  const dependabot = parse(readFileSync(join(root, '.github/dependabot.yml'), 'utf8'));
  expect(dependabot.updates.map((update: Record<string, string>) => update['package-ecosystem'])).toEqual(['npm', 'github-actions']);
});

it('ships a self-contained, accessible SVG logo without active or external image content', () => {
  const dom = new JSDOM(readFileSync(join(root, 'docs/assets/pico.svg'), 'utf8'), { contentType: 'image/svg+xml' });
  try {
    const document = dom.window.document;
    expect(document.documentElement.getAttribute('role')).toBe('img');
    expect(document.querySelector('title')?.textContent).toBe('Pico');
    expect(document.querySelector('desc')?.textContent).toBeTruthy();
    expect(document.querySelector('script, foreignObject, image, [href], [src]')).toBeNull();
  } finally { dom.window.close(); }
});

it('documents family prominently and keeps local-check help free of provisioning', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  expect(readme).toContain('## Family collaboration');
  expect(readme).toContain('same-host Unix sockets');
  expect(readme).toContain('docs/FAMILY.md#manual-acceptance-walkthrough');
  const script = join(root, 'scripts/check-family-local.mjs'), env = { PATH: '' };
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env });
  expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain('No model inference, real Telegram or Docker');
  for (const args of [[], ['--run', '--instance', '/not-an-authorized-instance']]) {
    const denied = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
    expect(denied.status).toBe(1); expect(denied.stderr).toContain('no existing instance arguments accepted');
    expect(denied.stderr).not.toContain('ENOENT');
  }
});

it('shows operator-check help and refuses unauthorized deployment mutations before Docker access', () => {
  const script = join(root, 'scripts/check-two-owners.mjs'), env = { PATH: '' };
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env });
  expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain('--authorize-disposable-deployment'); expect(help.stdout).toContain('restarts pico-owner-a');
  for (const args of [[], ['--authorize-disposable-deployment', '--unexpected']]) {
    const denied = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
    expect(denied.status).toBe(1); expect(denied.stderr).toContain('Only for an explicitly authorized disposable Docker deployment');
    expect(denied.stderr).not.toContain('spawnSync docker');
  }
});
