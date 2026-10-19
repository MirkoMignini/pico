import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { statistics } from '../examples/skills/text-statistics/scripts/statistics.mjs';
import { directoryPackage } from '../src/skill-package.js';
import { rpc } from '../src/daemon.js';
import { setup, source, waitFor } from './helpers.js';

const root = fileURLToPath(new URL('../examples/skills/text-statistics', import.meta.url));
const instances: ReturnType<typeof setup>[] = [];
afterEach(async () => { for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } });
const cli = (args: string[], input = '', cwd = root) => spawnSync(process.execPath, [join(root, 'scripts/analyze.mjs'), ...args], { input, cwd, encoding: 'utf8' });

it('ships a standalone English package with working scripts, reference documentation, an asset and a license', () => {
  const pkg = directoryPackage(root);
  expect(pkg.metadata.name).toBe('text-statistics');
  expect(pkg.files.map(file => file.path)).toEqual(expect.arrayContaining(['SKILL.md', 'LICENSE.txt', 'assets/example.txt', 'references/format.md', 'scripts/analyze.mjs', 'scripts/statistics.mjs', 'scripts/test.mjs']));
  const result = spawnSync(process.execPath, [join(root, 'scripts/test.mjs')], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ passed: true, cases: 11, invalidInputs: 8 });
});

it('defines Unicode, whitespace, blank-line and trailing-line-ending counts and strictly validates its JSON input', () => {
  expect(statistics({ text: 'Hi 👋\nBye' })).toEqual({ characters: 8, words: 3, lines: 2 });
  expect(statistics({ text: 'e\u0301' })).toEqual({ characters: 2, words: 1, lines: 1 });
  expect(statistics({ text: 'one\r\ntwo\rthree\n' })).toEqual({ characters: 15, words: 3, lines: 3 });
  expect(statistics({ text: '\n\n' })).toEqual({ characters: 2, words: 0, lines: 2 });
  expect(statistics({ text: '' })).toEqual({ characters: 0, words: 0, lines: 0 });
  expect(statistics({ text: 'word '.repeat(10000) })).toEqual({ characters: 50000, words: 10000, lines: 1 });
  for (const input of [null, [], {}, { text: 3 }, { text: 'hello', extra: true }]) expect(() => statistics(input)).toThrow('text string');
});

it('supports English CLI help and JSON-only successful stdout with nonzero errors for invalid input', () => {
  const help = cli(['--help']); expect(help.status).toBe(0); expect(help.stdout).toContain('Text statistics');
  for (const input of ['{"text":42}', '{"text":']) { const bad = cli([], input); expect(bad.status).toBe(1); expect(bad.stdout).toBe(''); expect(bad.stderr).toContain('text string'); }
  const good = cli([], JSON.stringify({ text: 'Hello, world!' })); expect(good.status, good.stderr).toBe(0); expect(good.stderr).toBe(''); expect(JSON.parse(good.stdout)).toEqual({ characters: 13, words: 2, lines: 1 });
  const asset = cli(['--file', 'assets/example.txt']); expect(asset.status, asset.stderr).toBe(0); expect(JSON.parse(asset.stdout)).toEqual({ characters: 30, words: 4, lines: 2 });
});

it('reads selected UTF-8 files, privately writes reports without overwriting, and refuses invalid encoding or escaping paths', () => {
  const s = setup('sample-skill-files'); instances.push(s); mkdirSync(join(s.root, 'inputs'));
  writeFileSync(join(s.root, 'inputs/draft.txt'), '\uFEFFHello 👋\n'); writeFileSync(join(s.root, 'inputs/invalid.txt'), Buffer.from([255]));
  const args = ['--file', 'inputs/draft.txt', '--output', 'outputs/report.json'], result = cli(args, '', s.root);
  expect(result.status, result.stderr).toBe(0); const report = { characters: 8, words: 2, lines: 1 };
  expect(JSON.parse(result.stdout)).toEqual(report); expect(JSON.parse(readFileSync(join(s.root, 'outputs/report.json'), 'utf8'))).toEqual(report); expect(statSync(join(s.root, 'outputs/report.json')).mode & 0o777).toBe(0o600);
  const repeated = cli(args, '', s.root); expect(repeated.status).toBe(1); expect(repeated.stdout).toBe(''); expect(JSON.parse(readFileSync(join(s.root, 'outputs/report.json'), 'utf8'))).toEqual(report);
  for (const args of [['--file', 'inputs/invalid.txt'], ['--file', '../escape'], ['--file', ''], ['--file', 'inputs/draft.txt', '--output', 'outputs/../escape.json'], ['--file', 'inputs/draft.txt', '--output', '']]) { const denied = cli(args, '', s.root); expect(denied.status).toBe(1); expect(denied.stdout).toBe(''); }
  expect(existsSync(join(s.root, 'escape.json'))).toBe(false);
});

it('uses the sample through agent-core with an uploaded input and a retained report attachment', async () => {
  const s = setup('sample-skill'); instances.push(s);
  await rpc(s.runtime, { op: 'skills.request', args: { action: 'import', localPath: root } });
  const attachmentId = s.runtime.media.save(Buffer.from('Hi 👋\nBye'), 'draft.txt', 'text/plain');
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('skills_run', { name: 'text-statistics', script: 'scripts/analyze.mjs', inputs: [{ attachmentId, path: 'draft.txt' }], args: ['--file', 'inputs/draft.txt', '--output', 'outputs/report.json'], outputs: ['outputs/report.json'] })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Analyzed with the installed skill.')])]);
  const run = await s.runtime.ingest({ requestId: 'sample-skill', conversationId: s.runtime.newConversation().id, text: 'Use $text-statistics and return a report' }, source);
  await waitFor(() => !s.runtime.hasPendingRuns); expect(s.runtime.run(run.id).status, s.runtime.run(run.id).error).toBe('completed');
  const operation = s.store.get<{ result: string }>("SELECT result FROM operations WHERE run_id=? AND tool='skills_run'", run.id)!;
  const receipt = JSON.parse(JSON.parse(operation.result).content[0].text); expect(receipt.status).toBe('completed'); expect(receipt.outputs).toHaveLength(1);
  const report = { characters: 8, words: 3, lines: 2 }; expect(JSON.parse(receipt.stdout)).toEqual(report);
  expect(JSON.parse(Buffer.from((await s.runtime.media.read(receipt.outputs[0].attachmentId)).bytes).toString())).toEqual(report);
});
