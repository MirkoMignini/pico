import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { Client } from '../src/client.js';
import { Runtime } from '../src/runtime.js';
import { rpc } from '../src/daemon.js';
import { atomicWrite } from '../src/config.js';
import { moduleHash, type ExtensionModule } from '../src/extensions.js';
import type { Envelope } from '../src/contracts.js';
import { setup, reply, source, waitFor, loadTools } from './helpers.js';

const example = JSON.parse(readFileSync(new URL('../examples/word-count.json', import.meta.url), 'utf8')) as ExtensionModule;
const instances: ReturnType<typeof setup>[] = [];
const customTools = (s: ReturnType<typeof setup>) => s.runtime.extensions.tools().filter(tool => !s.runtime.extensions.isBuiltinTool(tool.name));
const instance = () => { const s = setup('extension-fixture'); instances.push(s); return s; };
const owner = (s: ReturnType<typeof setup>): Envelope => ({ ownerId: s.config.ownerId, instanceId: s.config.instanceId, runId: crypto.randomUUID(), conversationId: '', source, mode: 'foreground' });
const activate = async (s: ReturnType<typeof setup>, module = example) => {
  const pending = await s.runtime.extensions.validateModule(module);
  await s.runtime.extensions.approve(pending.approvalId, pending.hash, true, owner(s)); return pending;
};
const invoke = (s: ReturnType<typeof setup>, name = 'word_count', input: unknown = { text: 'hello world' }) => s.runtime.invokeExtension(name, input, owner(s));
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } });

it('syntax-checks generated modules without executing any unapproved code', async () => {
  const s = instance(), marker = join(s.root, 'host-marker');
  const module = { ...example, source: `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n${example.source}` };
  const pending = await s.runtime.extensions.validateModule(module);
  expect(pending.hash).toBe(moduleHash(module)); expect(pending.report).toMatchObject({ syntaxChecked: true, executed: false, testsRun: false, isolation: 'none' });
  await s.runtime.start();
  expect(existsSync(marker)).toBe(false); await expect(invoke(s)).rejects.toThrow('missing');
  await s.runtime.extensions.approve(pending.approvalId, pending.hash, true, owner(s));
  expect(readFileSync(marker, 'utf8')).toBe(String(process.pid));
  expect((await invoke(s)).details).toEqual({ words: 2 });
  expect(s.runtime.extensions.status).toMatchObject({ mode: 'in-process', isolation: 'none', loaded: expect.arrayContaining(['notes-lists', 'documents', 'word-count']) });
  expect(s.store.all('SELECT * FROM grants')).toEqual([]);
});

it('requires exact fresh owner-terminal approval and rejects legacy approvals', async () => {
  const s = instance(), pending = await s.runtime.extensions.validateModule(example), context = owner(s);
  for (const invalid of [{ ...context, ownerId: 'foreign' }, { ...context, instanceId: 'foreign' }, { ...context, mode: 'ephemeral' as const }, { ...context, source: { ...source, trustedOwner: false } }, { ...context, source: { ...source, channel: 'telegram' } }]) {
    await expect(s.runtime.extensions.approve(pending.approvalId, pending.hash, true, invalid)).rejects.toThrow('owner-terminal');
  }
  await expect(s.runtime.extensions.approve(pending.approvalId, '0'.repeat(64), true, context)).rejects.toThrow('hash mismatch');
  s.store.run("UPDATE approvals SET operation='activate' WHERE id=?", pending.approvalId);
  await expect(s.runtime.extensions.approve(pending.approvalId, pending.hash, true, context)).rejects.toThrow('legacy');
  s.store.run("UPDATE approvals SET operation='activate-native' WHERE id=?", pending.approvalId);
  await s.runtime.extensions.approve(pending.approvalId, pending.hash, true, context);
  await expect(s.runtime.extensions.approve(pending.approvalId, pending.hash, true, context)).rejects.toThrow('consumed');
});

it('rejects malformed modules and syntax without creating artifacts or approvals', async () => {
  const s = instance();
  for (const invalid of [{ ...example, sdk: 1 }, { ...example, tests: 'extra' }, { ...example, id: '../escape' }, { ...example, source: 'export default function( {' }]) {
    await expect(s.runtime.extensions.validateModule(invalid)).rejects.toThrow();
  }
  expect(s.store.all('SELECT * FROM extension_artifacts')).toEqual([]); expect(s.store.all('SELECT * FROM approvals')).toEqual([]);
});

it('faux-model generation activates immediately without approval or claiming behavioral tests', async () => {
  const s = instance(), marker = join(s.root, 'generated-init');
  const module = { ...example, source: `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\n${example.source}` };
  reply(s.faux, JSON.stringify(module));
  const result = await rpc(s.runtime, { op: 'extensions.build', args: { specification: 'Count words' } }) as { buildId: string; hash: string; activated: boolean; tools: string[]; report: unknown };
  expect(result.hash).toBe(moduleHash(module)); expect(result.report).toMatchObject({ executed: false, testsRun: false });
  expect(result.activated).toBe(true); expect(result.tools).toEqual(['word_count']);
  expect(result).toMatchObject({ module: { source: module.source } });
  expect(s.faux.state.callCount).toBe(1); expect(readFileSync(marker, 'utf8')).toBe(String(process.pid));
  expect(s.store.all('SELECT * FROM approvals')).toEqual([]);
  expect(s.store.get('SELECT status FROM builds WHERE id=?', result.buildId)).toEqual({ status: 'active' });
  expect((await invoke(s)).details).toEqual({ words: 2 });
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models); await s.runtime.start();
  expect((await invoke(s)).details).toEqual({ words: 2 });
});

it('builds and uses a newly registered tool in the same owner chat with source lineage', async () => {
  const s = instance();
  s.faux.appendResponses([
    loadTools('extension_build'),
    fauxAssistantMessage([fauxToolCall('extension_build', { specification: 'Count words locally' }, 'build')]),
    fauxAssistantMessage([fauxText(JSON.stringify(example))]),
    loadTools('word_count'),
    fauxAssistantMessage([fauxToolCall('word_count', { text: 'hello new tool' }, 'count')]),
    fauxAssistantMessage([fauxText('Counted three words.')])
  ]);
  const conversation = s.runtime.newConversation(), run = await s.runtime.ingest({ requestId: 'build-and-use', conversationId: conversation.id, text: 'Create a word counter and count hello new tool' }, source);
  await waitFor(() => ['completed', 'failed'].includes(s.runtime.run(run.id).status));
  expect(s.runtime.run(run.id)).toMatchObject({ status: 'completed', partial: 'Counted three words.' });
  expect(s.store.get("SELECT status FROM operations WHERE run_id=? AND tool='word_count'", run.id)).toEqual({ status: 'completed' });
  expect(s.store.get('SELECT run_id FROM artifact_derivations WHERE artifact_hash=?', moduleHash(example))).toEqual({ run_id: run.id });
  expect(s.store.all('SELECT * FROM approvals')).toEqual([]);
});

it('gives a slow build one bounded allowance and exposes its tools on the next request without another load', async () => {
  const s = instance(); s.config.limits.runTimeoutMs = 1000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const complete = vi.spyOn(s.runtime.models, 'complete').mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 800));
    return fauxAssistantMessage([fauxText(JSON.stringify(example))]);
  });
  s.faux.appendResponses([
    loadTools('extension_build'),
    fauxAssistantMessage([fauxToolCall('extension_build', { specification: 'Count words locally' })]),
    async request => {
      expect(request.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? [])).toContainEqual(expect.objectContaining({ name: 'word_count' }));
      const result = request.messages.filter(message => message.role === 'toolResult').at(-1)!;
      const receipt = JSON.parse((result.content[0] as { text: string }).text);
      expect(receipt).toMatchObject({ activated: true, tools: ['word_count'], module: { id: example.id } });
      expect(receipt.module).not.toHaveProperty('source'); expect(receipt).not.toHaveProperty('specification');
      await new Promise(resolve => setTimeout(resolve, 400));
      return fauxAssistantMessage([fauxToolCall('word_count', { text: 'hello world' })]);
    },
    fauxAssistantMessage([fauxText('Built and counted two words.')])
  ]);
  const run = await s.runtime.ingest({ requestId: 'slow-build-and-reply', conversationId: s.runtime.newConversation().id, text: 'Build and use a word counter' }, source);
  await vi.waitFor(() => expect(s.runtime.hasPendingRuns).toBe(false), { timeout: 5000, interval: 10 });
  expect(s.runtime.run(run.id)).toMatchObject({ status: 'completed', partial: 'Built and counted two words.' });
  expect(s.runtime.run(run.id).updated_at - run.created_at).toBeGreaterThan(1000);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(s.store.all('SELECT tool FROM operations WHERE run_id=? AND tool=?', run.id, 'tools_load')).toHaveLength(1);
});

it('does not renew the build allowance for repeated builds and preserves completed effects on timeout', async () => {
  const s = instance(); s.config.limits.runTimeoutMs = 1000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const complete = vi.spyOn(s.runtime.models, 'complete').mockResolvedValue(fauxAssistantMessage([fauxText(JSON.stringify(example))]));
  let abortedAt = 0;
  s.faux.appendResponses([
    loadTools('extension_build'),
    fauxAssistantMessage([fauxToolCall('extension_build', { specification: 'Count words locally' })]),
    async () => {
      await new Promise(resolve => setTimeout(resolve, 1200));
      return fauxAssistantMessage([fauxToolCall('extension_build', { specification: 'Rebuild the synthetic word counter' })]);
    },
    async (_request, options) => {
      await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => { abortedAt = Date.now(); resolve(); }, { once: true }));
      return fauxAssistantMessage([fauxText('Never publish this late reply.')]);
    }
  ]);
  const events: any[] = []; s.runtime.events.on('output', event => { if (event.type === 'settled') events.push(event.data); });
  const run = await s.runtime.ingest({ requestId: 'bounded-build-allowance', conversationId: s.runtime.newConversation().id, text: 'Run two explicit synthetic builds' }, source);
  await vi.waitFor(() => expect(s.runtime.hasPendingRuns).toBe(false), { timeout: 5000, interval: 10 });
  expect(s.runtime.run(run.id)).toMatchObject({ status: 'cancelled', error: expect.stringContaining('extension build activated successfully') });
  expect(abortedAt - run.created_at).toBe(2000);
  expect(events).toMatchObject([{ status: 'cancelled', error: expect.stringContaining('follow-up work or response is incomplete') }]);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(s.store.all("SELECT status FROM builds WHERE status='active'")).toHaveLength(2);
  expect(customTools(s).map(tool => tool.name)).toEqual(['word_count']);
});

it.each(['timeout', 'owner cancellation'])('blocks late activation after %s during generation without replaying completion', async cancellation => {
  const s = instance(); s.config.limits.runTimeoutMs = 1000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let abortedAt = 0;
  const complete = vi.spyOn(s.runtime.models, 'complete').mockImplementation(async (_context, signal) => {
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => { abortedAt = Date.now(); resolve(); }, { once: true }));
    return fauxAssistantMessage([fauxText(JSON.stringify(example))]); // Provider may finish after cancellation.
  });
  const stage = vi.spyOn(s.runtime.extensions, 'stageBuild');
  s.faux.appendResponses([loadTools('extension_build'), fauxAssistantMessage([fauxToolCall('extension_build', { specification: 'Count words locally' })])]);
  const run = await s.runtime.ingest({ requestId: `cancel-generation-${cancellation}`, conversationId: s.runtime.newConversation().id, text: 'Build a word counter' }, source);
  if (cancellation === 'owner cancellation') {
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    s.runtime.cancel(run.id);
  }
  await vi.waitFor(() => expect(s.runtime.hasPendingRuns).toBe(false), { timeout: 5000, interval: 10 });
  expect(s.runtime.run(run.id).status).toBe('cancelled');
  if (cancellation === 'timeout') expect(abortedAt - run.created_at).toBe(2000);
  else expect(abortedAt - run.created_at).toBeLessThan(1000);
  expect(stage).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledTimes(1);
  expect(s.store.all('SELECT * FROM extension_artifacts')).toEqual([]); expect(customTools(s)).toEqual([]);
});

it('keeps the ordinary run deadline when no extension build starts', async () => {
  const s = instance(); s.config.limits.runTimeoutMs = 1000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let abortedAt = 0;
  s.faux.appendResponses([async (_request, options) => {
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => { abortedAt = Date.now(); resolve(); }, { once: true }));
    return fauxAssistantMessage([fauxText('Never publish a late answer.')]);
  }]);
  const run = await s.runtime.ingest({ requestId: 'ordinary-deadline', conversationId: s.runtime.newConversation().id, text: 'Hello' }, source);
  await vi.waitFor(() => expect(s.runtime.hasPendingRuns).toBe(false), { timeout: 5000, interval: 10 });
  expect(s.runtime.run(run.id)).toMatchObject({ status: 'cancelled', error: 'Run timed out; already accepted actions may still have effects' });
  expect(abortedAt - run.created_at).toBe(1000);
});

it('denies automatic activation outside this trusted retained owner execution', async () => {
  const s = instance(), context = owner(s);
  for (const invalid of [{ ...context, ownerId: 'foreign' }, { ...context, instanceId: 'foreign' }, ...(['ephemeral', 'scheduled', 'review'] as const).map(mode => ({ ...context, mode })), { ...context, source: { ...source, trustedOwner: false } }]) {
    await expect(s.runtime.extensions.stageBuild('missing', example, invalid)).rejects.toThrow('trusted retained owner');
  }
  await expect(s.runtime.extensions.stageBuild('missing', example, context)).rejects.toThrow('does not belong');
  const conversation = s.runtime.newConversation();
  s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', context.runId, conversation.id, context.runId, JSON.stringify(context), 'running', 1, 1);
  for (const mode of ['ephemeral', 'scheduled', 'review'] as const) {
    const tool = s.runtime.availableTools({ ...context, conversationId: conversation.id, mode }).find(tool => tool.name === 'extension_build')!;
    await expect(tool.execute(`denied-${mode}`, { specification: 'Count words' })).rejects.toThrow('cannot persist');
  }
  expect(s.faux.state.callCount).toBe(0); expect(s.store.all('SELECT * FROM extension_artifacts')).toEqual([]);
});

it('honors cancellation before import and disables a factory cancelled during initialization', async () => {
  const s = instance(), context = { ...owner(s), conversationId: s.runtime.newConversation().id }, marker = join(s.root, 'cancelled-init');
  s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', context.runId, context.conversationId, context.runId, JSON.stringify(context), 'running', 1, 1);
  const { buildId } = s.runtime.extensions.beginBuild('Synthetic cancellation', context);
  const module = { ...example, source: `import fs from 'node:fs';export default async function(pikobot){fs.appendFileSync(${JSON.stringify(marker)},'x');await new Promise(resolve=>setTimeout(resolve,30));}` };
  await expect(s.runtime.extensions.stageBuild(buildId, module, context, AbortSignal.abort(new Error('Synthetic cancellation')))).rejects.toThrow('Synthetic cancellation');
  expect(existsSync(marker)).toBe(false); expect(s.store.all('SELECT * FROM extension_artifacts')).toEqual([]);
  const controller = new AbortController(), activation = s.runtime.extensions.stageBuild(buildId, module, context, controller.signal);
  await waitFor(() => existsSync(marker)); controller.abort(new Error('Synthetic cancellation'));
  expect(await activation).toMatchObject({ activated: false, tools: [], error: 'Synthetic cancellation' });
  expect(s.store.get('SELECT enabled FROM extension_installs WHERE id=?', module.id)).toEqual({ enabled: 0 });
  expect(customTools(s)).toEqual([]);
});

it('repairs invalid generated syntax before activation', async () => {
  const s = instance(); reply(s.faux, JSON.stringify({ ...example, source: 'export default function( {' })); reply(s.faux, JSON.stringify(example));
  expect(await rpc(s.runtime, { op: 'extensions.build', args: { specification: 'Count words' } })).toMatchObject({ activated: true, tools: ['word_count'] });
  expect(s.faux.state.callCount).toBe(2); expect(s.store.all('SELECT * FROM extension_artifacts')).toHaveLength(1);
});

it.each(['Synthetic initialization failure', ''])('reports initialization failure (%j) without automatic repair, replay or activation on restart', async message => {
  const s = instance(), marker = join(s.root, 'failed-init');
  reply(s.faux, JSON.stringify({ ...example, source: `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');export default function(){throw new Error(${JSON.stringify(message)});}` }));
  const result = await rpc(s.runtime, { op: 'extensions.build', args: { specification: 'Count words' } }) as { buildId: string };
  expect(result).toMatchObject({ activated: false, tools: [], error: message || 'Extension activation failed; effects may already have occurred' });
  expect(s.faux.state.callCount).toBe(1); expect(readFileSync(marker, 'utf8')).toBe('x');
  expect(s.store.get('SELECT status FROM builds WHERE id=?', result.buildId)).toEqual({ status: 'failed' });
  expect(s.store.get('SELECT enabled FROM extension_installs WHERE id=?', example.id)).toEqual({ enabled: 0 });
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models); await s.runtime.start();
  expect(readFileSync(marker, 'utf8')).toBe('x'); expect(customTools(s)).toEqual([]);
});

it('does not replay an interrupted automatic initialization on restart', async () => {
  const s = instance(), marker = join(s.root, 'interrupted-init');
  const pending = await activate(s, { ...example, source: `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');\n${example.source}` });
  s.store.run('INSERT INTO builds(id,specification,status,artifact_hash,created_at) VALUES(?,?,?,?,?)', 'interrupted-build', 'Synthetic', 'activating', pending.hash, Date.now());
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models); await s.runtime.start();
  expect(readFileSync(marker, 'utf8')).toBe('x'); expect(customTools(s)).toEqual([]);
  expect(s.store.get('SELECT status FROM builds WHERE id=?', 'interrupted-build')).toEqual({ status: 'interrupted' });
});

it('validates inputs and denies foreign, ephemeral, scheduled and untrusted invocation', async () => {
  const s = instance(); await activate(s);
  await expect(invoke(s, 'word_count', { text: 123 })).rejects.toThrow('Invalid input');
  await expect(invoke(s, 'word_count', { text: 'ok', ownerId: 'forged' })).rejects.toThrow('Invalid input');
  const call = async (context: Envelope) => s.runtime.extensions.invoke('word_count', { text: 'ok' }, context, 'call', async () => { throw new Error('unused'); });
  await expect(call({ ...owner(s), ownerId: 'foreign' })).rejects.toThrow('Ownership mismatch');
  for (const mode of ['ephemeral', 'scheduled', 'review'] as const) await expect(call({ ...owner(s), mode })).rejects.toThrow('trusted retained foreground');
  await expect(call({ ...owner(s), source: { ...source, trustedOwner: false } })).rejects.toThrow('trusted retained foreground');
  expect((await invoke(s, 'word_count', { text: '  ' })).details).toEqual({ words: 0 });
});

it('loads instance-local TypeScript and directory modules, rejects collisions, and runs shutdown hooks', async () => {
  const s = instance(), directory = join(s.root, 'extensions'), marker = join(s.root, 'closed');
  mkdirSync(join(directory, 'second-module'), { recursive: true });
  writeFileSync(join(directory, 'first-module.ts'), `const label: string = 'Local'; export default function(pikobot: any){pikobot.on('shutdown',async()=>{const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'closed');});pikobot.registerTool({name:'local_tool',label,description:'Local tool',parameters:pikobot.Type.Object({}, {additionalProperties:false}),async execute(){return {content:[{type:'text',text:String(process.pid)}],details:{pid:process.pid}};}});}`);
  writeFileSync(join(directory, 'second-module', 'index.mjs'), example.source);
  writeFileSync(join(directory, 'zzz-collision.js'), example.source.replace('word_count', 'lists'));
  await s.runtime.start();
  expect(customTools(s).map(tool => tool.name)).toEqual(['local_tool', 'word_count']);
  expect(s.runtime.extensions.status.errors['zzz-collision']).toContain('reserved tool');
  expect((await invoke(s, 'local_tool', {})).details).toEqual({ pid: process.pid });
  await s.runtime.extensions.disable('first-module'); expect(readFileSync(marker, 'utf8')).toBe('closed');
  await expect(invoke(s, 'local_tool', {})).rejects.toThrow('missing');
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models); await s.runtime.start();
  expect(customTools(s).map(tool => tool.name)).toEqual(['word_count']);
});

it('publishes extension footer status through events and the owner status RPC, clearing it on disable', async () => {
  const s = instance(), directory = join(s.root, 'extensions'), events: { key: string; text: string | null }[] = [];
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'footer-status.ts'), `export default function(pikobot){pikobot.on('start',()=>pikobot.setStatus('Telegram','connected'));}`);
  s.runtime.events.on('output', event => { if (event.type === 'extension_status') events.push(event.data as { key: string; text: string | null }); });
  await s.runtime.start();
  expect(s.runtime.extensions.statuses).toEqual({ Telegram: 'connected' });
  expect(await rpc(s.runtime, { op: 'status' })).toMatchObject({ extensionStatus: { Telegram: 'connected' } });
  expect(events).toEqual([{ key: 'Telegram', text: 'connected' }]);
  await s.runtime.extensions.disable('footer-status');
  expect(s.runtime.extensions.statuses).toEqual({}); expect(events).toEqual([{ key: 'Telegram', text: 'connected' }, { key: 'Telegram', text: null }]);
});

it('preserves canonical core writes, nested journals, provenance and real named-tool agent execution', async () => {
  const s = instance();
  const module = { ...example, id: 'core-notes', source: `export default function(pikobot){pikobot.registerTool({name:'quick_list',label:'Quick list',description:'Save a list',parameters:pikobot.Type.Object({title:pikobot.Type.String()},{additionalProperties:false}),async execute(_id,params,_signal,_update,context){return context.callTool('lists',{action:'create',title:params.title,items:['One','Two']});}});}` };
  await activate(s, module);
  s.faux.appendResponses([loadTools('quick_list'), fauxAssistantMessage([fauxToolCall('quick_list', { title: 'Synthetic list' }, 'save')]), fauxAssistantMessage([fauxText('Saved')])]);
  const conversation = s.runtime.newConversation(), run = await s.runtime.ingest({ requestId: 'named-extension', conversationId: conversation.id, text: 'Make a synthetic list' }, source);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  const document = s.store.get<{ id: string }>("SELECT id FROM documents WHERE title='Synthetic list'")!;
  expect(s.runtime.knowledge.read(document.id).checklist).toMatchObject({ allItems: 2, incomplete: 2 });
  expect(s.store.all<{ tool: string; status: string }>('SELECT tool,status FROM operations WHERE run_id=? ORDER BY rowid', run.id)).toEqual([{ tool: 'tools_load', status: 'completed' }, { tool: 'quick_list', status: 'completed' }, { tool: 'lists', status: 'completed' }, ...Array.from({ length: 3 }, () => ({ tool: '$documents', status: 'completed' }))]);
  const revision = s.runtime.knowledge.read(document.id);
  expect(revision.conversion?.authoredBy).toBe(`assistant:${s.config.instanceId}`);
  const input = s.store.get<{ id: string }>("SELECT id FROM messages WHERE run_id=? AND role='user'", run.id)!;
  expect(revision.conversion?.dependencies).toContain(input.id);
});

it('reuses completed native receipts without replaying effects and denies changed arguments', async () => {
  const s = instance(), marker = join(s.root, 'effects');
  await activate(s, { ...example, source: `import fs from 'node:fs';${example.source.replace('const words =', `fs.appendFileSync(${JSON.stringify(marker)}, 'x'); const words =`)}` });
  const context = owner(s);
  const result = await s.runtime.invokeExtension('word_count', { text: 'one' }, context);
  const tool = (s.runtime as any).tools({ ...context, conversationId: s.store.meta('extensionConversation') }).find((tool: any) => tool.name === 'word_count');
  expect(await tool.execute('owner-invoke', { text: 'one' })).toEqual(result);
  expect(readFileSync(marker, 'utf8')).toBe('x');
  await expect(tool.execute('owner-invoke', { text: 'changed' })).rejects.toThrow('not replayed');
});

it('forgetting removes source-derived native artifacts and unloads their registered tools', async () => {
  const s = instance(), pending = await activate(s), fact = s.runtime.remember('synthetic-code-source', 'synthetic value') as { id: string; source_id: string };
  const context = owner(s); await s.runtime.invokeExtension('word_count', { text: 'lineage' }, context);
  s.store.run('INSERT INTO run_sources(run_id,source_id) VALUES(?,?)', context.runId, fact.source_id);
  s.store.run('INSERT INTO artifact_derivations VALUES(?,?)', pending.hash, context.runId);
  await s.runtime.forget(fact.id);
  expect(customTools(s)).toEqual([]); expect(s.store.all('SELECT * FROM extension_artifacts')).toEqual([]);
  await expect(invoke(s)).rejects.toThrow('missing');
});

it('counts asynchronous factory loading as busy work and cleans up if shutdown interrupts initialization', async () => {
  const s = instance(), marker = join(s.root, 'factory-cleanup');
  const pending = await s.runtime.extensions.validateModule({ ...example, source: `import fs from 'node:fs';export default async function(pikobot){pikobot.on('shutdown',()=>fs.writeFileSync(${JSON.stringify(marker)},'closed'));await new Promise(resolve=>setTimeout(resolve,50));}` });
  const activation = s.runtime.extensions.approve(pending.approvalId, pending.hash, true, owner(s));
  await waitFor(() => s.runtime.extensions.busy); expect(s.runtime.canApplySettings).toBe(false);
  await s.runtime.close(); await activation;
  expect(readFileSync(marker, 'utf8')).toBe('closed'); expect(s.runtime.extensions.tools()).toEqual([]);
});

it('cooperatively aborts calls and cleans resources on daemon close, without claiming hard termination', async () => {
  const s = instance(); await activate(s, { ...example, source: `export default function(pikobot){pikobot.registerTool({name:'wait_tool',label:'Wait',description:'Cooperative cancellation',parameters:pikobot.Type.Object({},{additionalProperties:false}),async execute(_id,_args,signal){await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return {content:[],details:null};}});}` });
  const pending = invoke(s, 'wait_tool', {}).catch(error => error);
  await waitFor(() => s.runtime.extensions.busy); expect(s.runtime.canApplySettings).toBe(false);
  await s.runtime.close(); expect(String(await pending)).toContain('Daemon stopping');
  expect(s.runtime.extensions.busy).toBe(false);
});

it('disable, rollback and runtime reconstruction preserve native approval without reactivating worker bundles', async () => {
  const s = instance(); await activate(s);
  await activate(s, { ...example, version: '1.1.0', source: example.source.replace('details: { words }', 'details: { words, version: 2 }') });
  expect((await invoke(s)).details).toEqual({ words: 2, version: 2 });
  await s.runtime.extensions.rollback(example.id); expect((await invoke(s)).details).toEqual({ words: 2 });
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models); await s.runtime.start();
  expect((await invoke(s)).details).toEqual({ words: 2 });
  await s.runtime.extensions.disable(example.id); await expect(invoke(s)).rejects.toThrow('missing');
  expect(s.store.all('SELECT * FROM extension_artifacts')).toHaveLength(2);
});

it('keeps legacy artifacts inert and refuses tampered approved source on restart', async () => {
  const s = instance(), marker = join(s.root, 'legacy-effect');
  const legacy = { manifest: { sdk: 1, id: 'legacy-worker' }, source: `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad')`, tests: 'legacy' };
  s.store.run('INSERT INTO extension_artifacts VALUES(?,?,?,?,?,?)', 'legacy-hash', 'legacy-worker', '1.0.0', JSON.stringify(legacy), '{}', Date.now());
  s.store.run('INSERT INTO extension_installs(id,active_hash,enabled) VALUES(?,?,1)', 'legacy-worker', 'legacy-hash');
  await activate(s); s.store.run('UPDATE extension_artifacts SET bundle=? WHERE hash=?', JSON.stringify({ ...example, source: example.source + '\n// tampered' }), moduleHash(example));
  await s.runtime.start();
  expect(existsSync(marker)).toBe(false); expect(s.runtime.extensions.status.errors['legacy-worker']).toContain('Invalid input');
  expect(s.runtime.extensions.status.errors['word-count']).toContain('integrity');
});

it('RPC validates the new module contract, journals invocation, and refuses activation during active work', async () => {
  const s = instance(); await activate(s);
  const result = await rpc(s.runtime, { op: 'extensions.invoke', args: { id: 'word_count', input: { text: 'RPC fixture' } } });
  expect(result).toMatchObject({ details: { words: 2 } });
  expect(s.store.get("SELECT status FROM operations WHERE tool='word_count'")).toEqual({ status: 'completed' });
  await expect(rpc(s.runtime, { op: 'extensions.validate', args: { bundle: example } })).rejects.toThrow('Invalid input');
  await expect(rpc(s.runtime, { op: 'extensions.invoke', args: { id: 'word_count', input: {}, ownerId: 'forged' } })).rejects.toThrow('Invalid input');
  s.store.run("UPDATE runs SET status='running'");
  await expect(rpc(s.runtime, { op: 'extensions.disable', args: { id: example.id } })).rejects.toThrow('Wait for active work');
});

it('compiled CLI runs a TypeScript tool in its actual daemon PID by default and survives settings apply', async () => {
  const s = instance(); s.config.model = { provider: 'openai', id: 'gpt-4o-mini' }; atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  mkdirSync(join(s.root, 'extensions'));
  writeFileSync(join(s.root, 'extensions', 'process-probe.ts'), `const label: string='Process';export default function(pikobot: any){pikobot.registerTool({name:'process_probe',label,description:'Synthetic process proof',parameters:pikobot.Type.Object({},{additionalProperties:false}),async execute(){return {content:[{type:'text',text:String(process.pid)}],details:{pid:process.pid}};}});}`);
  const child = spawn(process.execPath, ['dist/cli.js', '--instance', s.root, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false; child.stdout.on('data', data => { if (data.toString().includes('daemon_ready')) ready = true; }); child.stderr.on('data', () => {});
  const client = new Client(s.root);
  try {
    await waitFor(() => ready, 10_000); await client.ensureDaemon();
    expect(await client.rpc('status')).toMatchObject({ pid: child.pid, extensionsExecution: { mode: 'in-process', isolation: 'none' } });
    expect(await client.rpc('extensions.invoke', { id: 'process_probe', input: {} })).toMatchObject({ details: { pid: child.pid } });
    await client.rpc('settings.apply');
    expect(await client.rpc('extensions.invoke', { id: 'process_probe', input: {} })).toMatchObject({ details: { pid: child.pid } });
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } }
}, 30_000);
