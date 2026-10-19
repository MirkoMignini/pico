import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { doctor, formatDoctor } from '../src/doctor.js';
import { atomicWrite, initialize, loadConfig } from '../src/config.js';
import { Client } from '../src/client.js';
import { serve, rpc } from '../src/daemon.js';
import { Runtime } from '../src/runtime.js';
import { runtimeReadiness } from '../src/readiness.js';
import { setup } from './helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function instance() {
  const s = setup('PRIVATE-OWNER-SENTINEL'); atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  cleanup.push(async () => { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }); return s;
}
function snapshot(root: string): unknown {
  return readdirSync(root).sort().map(name => { const path = join(root, name), stat = lstatSync(path); return [name, stat.mode, stat.isDirectory() ? snapshot(path) : readFileSync(path).toString('base64')]; });
}
it('never creates a missing instance while loading configuration or diagnosing it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pikobot-doctor-')); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const missing = join(parent, 'missing'); expect(() => loadConfig(missing)).toThrow();
  const result = await doctor(missing); expect(result.ok).toBe(false); expect(existsSync(missing)).toBe(false);
  expect(JSON.stringify(result)).not.toContain(parent);
});
it('diagnoses an initialized but stopped instance without database creation, inference, credential refresh or writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pikobot-doctor-new-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, 'PRIVATE-OWNER-SENTINEL');
  const before = snapshot(root), start = vi.spyOn(Runtime.prototype, 'start'), network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
  const result = await doctor(root);
  expect(result.checks.find(check => check.id === 'database')?.status).toBe('warn');
  expect(result.checks.find(check => check.id === 'daemon')?.status).toBe('warn');
  expect(snapshot(root)).toEqual(before); expect(start).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  expect(result.readiness?.items[0]).toMatchObject({ credential: 'missing', authenticated: 'unverified', tested: 'not-run' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE-OWNER-SENTINEL'); expect(JSON.stringify(result)).not.toContain(root);
});
it('redacts invalid config, unsafe permissions and symlink paths without printing raw errors or repairing them', async () => {
  const s = instance(), secret = 'PRIVATE-CONFIG-SENTINEL';
  atomicWrite(join(s.root, 'config.json'), JSON.stringify({ ...s.config, [secret]: 'PRIVATE-VALUE' }));
  let result = await doctor(s.root, true); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(secret);
  atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config)); chmodSync(join(s.root, 'config.json'), 0o644);
  result = await doctor(s.root, true); expect(result.ok).toBe(false); expect(lstatSync(join(s.root, 'config.json')).mode & 0o777).toBe(0o644);
  const link = `${s.root}-link`; symlinkSync(s.root, link); cleanup.push(() => rmSync(link));
  result = await doctor(link, true); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(link);
});
it('uses only allowlisted health from a running daemon without exposing owner content or vault values', async () => {
  const s = instance(); await s.runtime.credentials.modify(s.config.model.provider, async () => ({ type: 'api_key', key: 'PRIVATE-KEY-SENTINEL' }));
  s.runtime.knowledge.createNote('PRIVATE-DOCUMENT-SENTINEL', 'PRIVATE-BODY-SENTINEL', 'synthetic-doctor');
  const service = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models) }); cleanup.push(service.close);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
  const credentials = vi.spyOn(s.runtime.credentials, 'modify');
  const result = await doctor(s.root), output = JSON.stringify(result) + formatDoctor(result);
  expect(result.checks.find(check => check.id === 'daemon')?.status).toBe('pass'); expect(result.checks.find(check => check.id === 'integrity')?.status).toBe('pass');
  for (const secret of ['PRIVATE-OWNER-SENTINEL', 'PRIVATE-KEY-SENTINEL', 'PRIVATE-DOCUMENT-SENTINEL', 'PRIVATE-BODY-SENTINEL', s.root, s.config.ownerId, s.config.instanceId]) expect(output).not.toContain(secret);
  expect(network).not.toHaveBeenCalled(); expect(credentials).not.toHaveBeenCalled(); expect(s.faux.state.callCount).toBe(0);
  await expect(new Client(s.root).rpc('health', { extra: true })).rejects.toThrow('Invalid input');
});
it('separates stored credentials from explicit selected-model test evidence and invalidates it after account changes', async () => {
  const s = instance();
  await s.runtime.credentials.modify(s.config.model.provider, async () => ({ type: 'api_key', key: 'fixture-account-one' }));
  expect((await runtimeReadiness(s.runtime)).items[0]).toMatchObject({ credential: 'stored', authenticated: 'unverified', reachable: 'unverified', tested: 'not-run' });
  s.faux.appendResponses([fauxAssistantMessage([fauxText('Pikobot is connected.')])]);
  expect(await rpc(s.runtime, { op: 'auth.test' })).toMatchObject({ tested: 'passed' });
  expect((await runtimeReadiness(s.runtime)).items[0]).toMatchObject({ authenticated: 'verified', reachable: 'verified', tested: 'passed' });
  await s.runtime.credentials.modify(s.config.model.provider, async () => ({ type: 'api_key', key: 'fixture-account-two' }));
  expect((await runtimeReadiness(s.runtime)).items[0]).toMatchObject({ authenticated: 'unverified', tested: 'not-run' });
  expect(s.store.all('SELECT * FROM messages')).toEqual([]); expect(s.faux.state.callCount).toBe(1);
});
it('shows a tested default model in the background row of a different selected conversation', async () => {
  const s = instance(), conversation = s.runtime.newConversation('Synthetic selected model');
  s.runtime.model(conversation.id, { provider: 'deepseek', id: 'deepseek-flash' });
  s.faux.appendResponses([fauxAssistantMessage([fauxText('Pikobot is connected.')])]);
  expect(await rpc(s.runtime, { op: 'auth.test' })).toMatchObject({ tested: 'passed' });
  const result = await runtimeReadiness(s.runtime, conversation.id);
  expect(result.items.find(item => item.id === 'model')).toMatchObject({ authenticated: 'unverified', tested: 'not-run' });
  expect(result.items.find(item => item.id === 'background-model')).toMatchObject({ authenticated: 'verified', reachable: 'verified', tested: 'passed' });
  expect(s.faux.state.callCount).toBe(1);
});
it('distinguishes a reachable model with a failed answer check from an interrupted/uncertain request', async () => {
  const s = instance(); s.faux.appendResponses([fauxAssistantMessage([fauxText('Unexpected synthetic response')])]);
  expect(await rpc(s.runtime, { op: 'auth.test' })).toMatchObject({ tested: 'failed' });
  expect((await runtimeReadiness(s.runtime)).items[0]).toMatchObject({ authenticated: 'verified', reachable: 'verified', tested: 'failed' });
  vi.spyOn(s.runtime.models, 'complete').mockRejectedValue(new Error('PRIVATE-PROVIDER-ERROR'));
  await expect(rpc(s.runtime, { op: 'auth.test' })).rejects.toThrow('acceptance or charges may be uncertain');
  expect((await runtimeReadiness(s.runtime)).items[0]).toMatchObject({ authenticated: 'unverified', tested: 'uncertain' });
  const session = s.runtime.newConversation('volatile', true);
  await expect(rpc(s.runtime, { op: 'auth.test', args: { conversationId: session.id } })).rejects.toThrow('retained session');
});
it('keeps optional services separate, reflects disabled modules and pending saved settings', async () => {
  const s = instance(); s.config.embeddings = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };
  s.config.transcription = { provider: 'openai', model: 'gpt-4o-mini-transcribe' };
  await s.runtime.credentials.modify('openai-api', async () => ({ type: 'api_key', key: 'fixture-api-key' }));
  let result = await runtimeReadiness(s.runtime);
  expect(result.items.find(item => item.id === 'embeddings')).toMatchObject({ enabled: true, credential: 'stored', authenticated: 'unverified', tested: 'not-run' });
  expect(result.items.find(item => item.id === 'transcription')).toMatchObject({ credential: 'stored', tested: 'not-run' }); expect(result.settingsPending).toBe(true);
  s.store.setMeta('extensions.disabled', JSON.stringify(['web']));
  result = await runtimeReadiness(s.runtime); expect(result.items.find(item => item.id === 'search')?.enabled).toBe(false);
});
it('offers compiled CLI help/version/offline diagnostics without creating or starting an owner', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pikobot-doctor-cli-')); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'missing'), cli = new URL('../dist/cli.js', import.meta.url).pathname, execute = promisify(execFile);
  for (const flag of ['--help', '--version']) {
    const result = await execute(process.execPath, [cli, '--instance', root, flag], { timeout: 20_000 }); expect(result.stdout).toContain('Pikobot');
  }
  const result = await execute(process.execPath, [cli, '--instance', root, 'doctor', '--offline', '--json'], { timeout: 20_000 }).catch(error => error);
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).ok).toBe(false); expect(existsSync(root)).toBe(false);
  const status = await execute(process.execPath, [cli, '--instance', root, 'status'], { timeout: 20_000 }).catch(error => error);
  expect(status.code).toBe(1); expect(existsSync(root)).toBe(false);
}, 90_000);
