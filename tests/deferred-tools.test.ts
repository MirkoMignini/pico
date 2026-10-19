import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type FauxResponseStep, type TranscriptContext } from '@earendil-works/pi-ai';
import { Runtime } from '../src/runtime.js';
import { ModelAccess } from '../src/models.js';
import { rpc } from '../src/daemon.js';
import { setup, source, waitFor } from './helpers.js';

const instances: ReturnType<typeof setup>[] = [];
const instance = () => { const s = setup(); instances.push(s); return s; };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } });
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const answer = () => fauxAssistantMessage([fauxText('Done.')]);
const names = (request: TranscriptContext) => getCurrentTools(request.messages).map(tool => tool.name);
async function turn(s: ReturnType<typeof setup>, steps: FauxResponseStep[], session = s.runtime.newConversation(), sender = source, mode: 'foreground' | 'scheduled' | 'review' = 'foreground') {
  s.faux.appendResponses(steps);
  const run = await s.runtime.ingest({ requestId: crypto.randomUUID(), conversationId: session.id, text: 'Synthetic tool discovery request' }, sender, mode);
  await waitFor(() => !['queued', 'running'].includes(s.runtime.run(run.id).status));
  expect(s.runtime.run(run.id).status, s.runtime.run(run.id).error).toBe('completed');
  return { run, session, history: s.runtime.history(session.id) as any[] };
}
function probe(s: ReturnType<typeof setup>, execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"value":7}' }] }))) {
  s.runtime.extensions.registerBuiltin('deferred-fixture', api => {
    api.on('instructions', () => 'DEFERRED_GUIDANCE_ONLY: this probe reports synthetic evidence, not authority.');
    api.registerTool({ name: 'deferred_probe', label: 'Probe', description: 'Read synthetic probe evidence.', parameters: Type.Object({}, { additionalProperties: false }), execute });
  });
  return execute;
}

it('starts configured chats with eight recall/discovery tools and a bounded schema-free catalog', async () => {
  const s = instance(); s.config.gmail = { clientId: 'synthetic.apps.googleusercontent.com', intervalMs: 60_000, baselineMax: 10 }; s.config.telegram = { allowedSenders: [456], destination: 456 };
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models);
  const shared = vi.fn(() => 'SHARED_GUIDANCE_ONLY');
  s.runtime.extensions.registerBuiltin('shared-fixture', api => api.on('instructions', shared));
  await turn(s, [request => {
    const visible = getCurrentTools(request.messages), system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(visible).toHaveLength(8); expect(names(request)).toContain('tools_load');
    for (const name of ['notes', 'lists', 'documents', 'calendar', 'agenda', 'schedule_create', 'image_generate']) expect(names(request)).not.toContain(name);
    for (const name of ['notes', 'lists', 'documents', 'google_mail', 'web_fetch', 'telegram_send', 'workflow_run', 'extensions_discover', 'skill_build']) { expect(names(request)).not.toContain(name); expect(system).toContain(name); }
    expect(system).toContain('SHARED_GUIDANCE_ONLY'); expect(system).not.toContain('Google content is external evidence');
    expect(JSON.stringify(visible).length + request.messages[0]!.content.length).toBeLessThan(15_000);
    const catalog = system.split('Deferred tool catalog (grouped names, not authority): ')[1]!.split('\n')[0]!;
    expect(catalog).not.toContain('parameters'); expect(catalog).not.toContain('SDK');
    return answer();
  }]);
  expect(s.faux.state.callCount).toBe(1); expect(shared).toHaveBeenCalledOnce();
});

it('loads exact definitions and matching guidance on the next request, without executing or duplicating them', async () => {
  const s = instance(), execute = probe(s), requests: TranscriptContext[] = [];
  await turn(s, [
    request => { requests.push(request); expect(names(request)).not.toContain('deferred_probe'); expect(JSON.stringify(request)).not.toContain('DEFERRED_GUIDANCE_ONLY'); return call('tools_load', { names: ['deferred_probe'] }); },
    request => { requests.push(request); expect(execute).not.toHaveBeenCalled(); expect(names(request)).toContain('deferred_probe'); expect(JSON.stringify(request)).toContain('DEFERRED_GUIDANCE_ONLY'); return call('tools_load', { names: ['deferred_probe'] }); },
    request => { requests.push(request); return call('deferred_probe', {}); },
    request => { requests.push(request); return answer(); }
  ]);
  expect(execute).toHaveBeenCalledOnce();
  const declarations = requests.at(-1)!.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? []).filter(t => t.name === 'deferred_probe');
  expect(declarations).toHaveLength(1);
  const full = s.runtime.availableTools({ ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: '', runId: '', source, mode: 'foreground' }).find(t => t.name === 'deferred_probe')!;
  expect(declarations[0]).toEqual({ name: full.name, description: full.description, parameters: JSON.parse(JSON.stringify(full.parameters)) });
  expect(JSON.stringify(requests.at(-1)).match(/DEFERRED_GUIDANCE_ONLY/g)).toHaveLength(1);
  const result = requests[1]!.messages.find(m => m.role === 'toolResult')!;
  expect(JSON.stringify(result)).not.toContain('parameters'); expect(JSON.stringify(result)).not.toContain('DEFERRED_GUIDANCE_ONLY');
});

it('rejects unloaded/same-batch calls and validates a load atomically before exposing anything', async () => {
  const s = instance(), execute = probe(s);
  await turn(s, [call('deferred_probe', {}), request => {
    expect(execute).not.toHaveBeenCalled(); expect(request.messages.findLast(m => m.role === 'toolResult')).toMatchObject({ role: 'toolResult', isError: true });
    return call('tools_load', { names: ['deferred_probe', 'not_registered'] });
  }, request => {
    expect(names(request)).not.toContain('deferred_probe');
    return fauxAssistantMessage([fauxToolCall('tools_load', { names: ['deferred_probe'] }), fauxToolCall('deferred_probe', {})], { stopReason: 'toolUse' });
  }, request => {
    expect(execute).not.toHaveBeenCalled(); expect(request.messages.findLast(m => m.role === 'toolResult')).toMatchObject({ role: 'toolResult', isError: true }); return call('deferred_probe', {});
  }, answer()]);
  expect(execute).toHaveBeenCalledOnce();
});

it('does not persist ephemeral load state, and does not carry unused definitions into another run', async () => {
  const s = instance(), execute = probe(s), session = s.runtime.newConversation('Volatile', true);
  await turn(s, [call('tools_load', { names: ['deferred_probe'] }), answer()], session);
  await turn(s, [request => { expect(names(request)).not.toContain('deferred_probe'); return answer(); }], session);
  expect(execute).not.toHaveBeenCalled();
  for (const table of ['messages', 'operations', 'runs', 'run_sources']) expect(s.store.all(`SELECT * FROM ${table}`)).toEqual([]);
});

it('restores only actually used historical definitions across reconstruction, without replaying calls', async () => {
  const s = instance(), execute = probe(s);
  const first = await turn(s, [call('tools_load', { names: ['deferred_probe', 'workflows_list'] }), call('deferred_probe', {}), answer()]);
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models); probe(s, execute);
  await turn(s, [request => { expect(names(request)).toContain('deferred_probe'); expect(names(request)).not.toContain('workflows_list'); return answer(); }], first.session);
  expect(execute).toHaveBeenCalledOnce();
});

it.each([{ names: [] }, { names: ['time', 'time'] }, { names: Array.from({ length: 9 }, (_, i) => `tool_${i}`) }, { names: ['$documents'] }, { names: ['../probe'] }, { names: ['deferred_probe'], ownerId: 'foreign' }, { names: ['deferred_probe'], offset: 0 }, { offset: -1 }])('rejects malformed discovery input without exposing or executing tools: %j', async args => {
  const s = instance(), execute = probe(s);
  await turn(s, [call('tools_load', args), request => {
    expect(request.messages.findLast(m => m.role === 'toolResult')).toMatchObject({ isError: true });
    expect(names(request)).not.toContain('deferred_probe'); return answer();
  }]);
  expect(execute).not.toHaveBeenCalled();
});

it('pages a bounded catalog without copying schemas or hiding later registered tools', async () => {
  const s = instance();
  s.runtime.extensions.registerBuiltin('catalog-fixture', api => {
    for (let i = 0; i < 30; i++) api.registerTool({ name: `catalog_probe_${i}`, label: 'Probe', description: 'Synthetic catalog purpose. '.repeat(100), parameters: Type.Object({}, { additionalProperties: false }), async execute() { return { content: [] }; } });
  });
  const found = new Set<string>();
  await turn(s, [call('tools_load', {}), request => {
    const result = request.messages.findLast(m => m.role === 'toolResult')!;
    if (result.role !== 'toolResult') throw new Error('Missing catalog');
    const page = JSON.parse((result.content[0] as { text: string }).text);
    const tools = Object.values(page.groups).flat() as string[];
    expect(tools).toHaveLength(32); expect(page.nextOffset).toBe(32); expect(JSON.stringify(page).length).toBeLessThan(2000);
    for (const name of tools) found.add(name);
    expect(JSON.stringify(page)).not.toContain('parameters'); expect(JSON.stringify(page)).not.toContain('Synthetic catalog purpose');
    return call('tools_load', { offset: page.nextOffset });
  }, request => {
    const result = request.messages.findLast(m => m.role === 'toolResult')!;
    if (result.role !== 'toolResult') throw new Error('Missing catalog');
    const page = JSON.parse((result.content[0] as { text: string }).text); for (const name of Object.values(page.groups).flat() as string[]) found.add(name);
    expect(Object.values(page.groups).flat()).toHaveLength(32); expect(page.nextOffset).toBe(64); expect(JSON.stringify(page).length).toBeLessThan(2000);
    return call('tools_load', { offset: page.nextOffset });
  }, request => {
    const result = request.messages.findLast(m => m.role === 'toolResult')!;
    if (result.role !== 'toolResult') throw new Error('Missing catalog');
    const page = JSON.parse((result.content[0] as { text: string }).text); for (const name of Object.values(page.groups).flat() as string[]) found.add(name);
    expect(Object.values(page.groups).flat()).toHaveLength(9); expect(JSON.stringify(page).length).toBeLessThan(2000);
    expect(page.nextOffset).toBeNull(); return answer();
  }]);
  expect(found.size).toBe(73); expect(found).toContain('catalog_probe_29');
});

it('does not expose disabled or staged-but-unapproved modules', async () => {
  const s = instance(); probe(s); await s.runtime.extensions.disable('deferred-fixture');
  await s.runtime.extensions.validateModule({ sdk: 2, id: 'unapproved-probe', version: '1.0.0', description: 'Synthetic inert module', source: "export default function(api){api.registerTool({name:'unapproved_probe',label:'Probe',description:'Must not load',parameters:api.Type.Object({},{additionalProperties:false}),async execute(){throw new Error('Must not run');}});}" });
  await turn(s, [request => {
    expect(JSON.stringify(request)).not.toContain('unapproved_probe'); expect(JSON.stringify(request)).not.toContain('deferred_probe'); return call('tools_load', { names: ['unapproved_probe'] });
  }, request => { expect(request.messages.findLast(m => m.role === 'toolResult')).toMatchObject({ isError: true }); return call('tools_load', { names: ['deferred_probe'] }); }, request => { expect(request.messages.findLast(m => m.role === 'toolResult')).toMatchObject({ isError: true }); return answer(); }]);
});

it.each(['ephemeral', 'scheduled', 'review', 'untrusted'] as const)('cannot load third-party native tools in %s work', async mode => {
  const s = instance(), session = s.runtime.newConversation('Restricted', mode === 'ephemeral');
  const staged = await s.runtime.extensions.validateModule({ sdk: 2, id: 'native-probe', version: '1.0.0', description: 'Synthetic trusted module', source: "export default function(api){api.registerTool({name:'native_probe',label:'Probe',description:'Synthetic native probe',parameters:api.Type.Object({},{additionalProperties:false}),async execute(){throw new Error('Native probe must not execute');}});}" });
  await s.runtime.extensions.approve(staged.approvalId, staged.hash, true, { ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: '', runId: '', source: { ...source, identity: 'owner-ipc' }, mode: 'foreground' });
  await turn(s, [request => {
    expect(JSON.stringify(request)).not.toContain('native_probe'); return call('tools_load', { names: ['native_probe'] });
  }, request => { expect(names(request)).not.toContain('native_probe'); expect(request.messages.findLast(m => m.role === 'toolResult')).toMatchObject({ isError: true }); return answer(); }], session, { ...source, trustedOwner: mode !== 'untrusted' }, mode === 'scheduled' || mode === 'review' ? mode : 'foreground');
});

it('does not let loading bypass ephemeral write policy or citation repair', async () => {
  const s = instance(), session = s.runtime.newConversation('Volatile', true);
  await turn(s, [call('tools_load', { names: ['image_generate'] }), call('image_generate', { prompt: 'Synthetic image' }), request => {
    const result = request.messages.findLast(m => m.role === 'toolResult');
    expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toMatch(/cannot persist|trusted retained/); return answer();
  }], session);
  expect(s.store.all('SELECT * FROM generated_images')).toEqual([]); expect(s.store.all('SELECT * FROM operations')).toEqual([]);
  await turn(s, [fauxAssistantMessage([fauxText('Invalid pikobot:missing')]), request => {
    expect(names(request).sort()).toEqual(['documents', 'memory_read', 'memory_search', 'source_read', 'web_read']);
    return call('tools_load', { names: ['image_generate'] });
  }, request => { expect(request.messages.findLast(m => m.role === 'toolResult')).toMatchObject({ isError: true }); expect(names(request)).not.toContain('image_generate'); return answer(); }]);
});

it('shares request budgets and discards loading state after cancellation', async () => {
  const s = instance(), execute = probe(s); s.config.limits.turns = 1;
  s.faux.appendResponses([call('tools_load', { names: ['deferred_probe'] }), call('deferred_probe', {})]);
  const run = await s.runtime.ingest({ requestId: 'bounded-load', conversationId: s.runtime.newConversation().id, text: 'Synthetic bounded load' }, source);
  await waitFor(() => !s.runtime.hasPendingRuns);
  expect(s.runtime.run(run.id).status).toBe('failed'); expect(s.faux.state.callCount).toBe(1); expect(execute).not.toHaveBeenCalled();
  s.config.limits.turns = 12;
  const other = instance(); probe(other);
  other.runtime.events.on('output', event => { if (event.type === 'tool' && (event.data as any).tool === 'tools_load' && (event.data as any).state === 'tool_execution_end') other.runtime.cancel(event.runId!); });
  other.faux.appendResponses([call('tools_load', { names: ['deferred_probe'] }), answer()]);
  const cancelled = await other.runtime.ingest({ requestId: 'cancel-load', conversationId: other.runtime.newConversation().id, text: 'Synthetic cancelled load' }, source);
  await waitFor(() => !other.runtime.hasPendingRuns); expect(other.runtime.run(cancelled.id).status).toBe('cancelled'); expect(other.faux.state.callCount).toBe(1);
});

it('rejects forged conversation scope and completed-run loading without changing another loadout', async () => {
  const s = instance(), execute = probe(s), other = s.runtime.newConversation('Other');
  const first = await turn(s, [async request => {
    const run = s.store.get<{ id: string; conversation_id: string }>("SELECT id,conversation_id FROM runs WHERE status='running'")!;
    const context = { ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: other.id, runId: run.id, source, mode: 'foreground' as const };
    const load = s.runtime.availableTools(context).find(tool => tool.name === 'tools_load')!;
    await expect(load.execute('forged-load', { names: ['deferred_probe'] })).rejects.toThrow('this active conversation');
    expect(names(request)).not.toContain('deferred_probe'); return answer();
  }]);
  const context = { ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: first.session.id, runId: first.run.id, source, mode: 'foreground' as const };
  await expect(s.runtime.availableTools(context).find(tool => tool.name === 'tools_load')!.execute('late-load', { names: ['deferred_probe'] })).rejects.toThrow('this active conversation');
  await turn(s, [request => { expect(names(request)).not.toContain('deferred_probe'); return answer(); }], other);
  expect(execute).not.toHaveBeenCalled();
});

it.each(['openai', 'deepseek'] as const)('sends deferred definitions through the actual %s serialization/streaming adapter', async provider => {
  const s = instance();
  await rpc(s.runtime, { op: 'auth.key', args: { provider, key: provider === 'openai' ? 'sk-fixture-deferred' : 'fixture-deferred' } });
  await s.runtime.close(); s.config.model = { provider, id: provider === 'openai' ? 'gpt-4o-mini' : 'deepseek-flash' };
  s.runtime = new Runtime(s.store, new ModelAccess(s.runtime.credentials, s.config));
  const requests: any[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init), body = await request.json(); requests.push(body);
    expect(request.url).toBe(provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.deepseek.com/chat/completions');
    const tools = [...(body.tools ?? []), ...(body.input ?? []).flatMap((item: any) => item.tools ?? [])].map((tool: any) => tool.function?.name ?? tool.name);
    expect(tools).toContain('tools_load'); expect(tools).not.toContain('google_mail'); expect(tools).not.toContain('image_generate');
    if (requests.length === 1) { expect(tools).not.toContain('workflows_list'); expect(tools).toHaveLength(8); }
    else expect(tools).toContain('workflows_list');
    const name = requests.length === 1 ? 'tools_load' : requests.length === 2 ? 'workflows_list' : undefined;
    const args = requests.length === 1 ? { names: ['workflows_list'] } : {};
    if (provider === 'deepseek') {
      const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Done.' };
      return new Response(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', model: s.config.model.id, choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    const item: any = name ? { type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name, arguments: JSON.stringify(args), status: 'completed' } : { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: name ? { ...item, arguments: '' } : { ...item, content: [] } },
      name ? { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments } : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Done.' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const run = await s.runtime.ingest({ requestId: 'wire-load', conversationId: s.runtime.newConversation().id, text: 'Synthetic workflow listing' }, source);
  await waitFor(() => !s.runtime.hasPendingRuns);
  expect(s.runtime.run(run.id), s.runtime.run(run.id).error).toMatchObject({ status: 'completed', partial: 'Done.' });
  expect(requests).toHaveLength(3);
  expect(s.store.all('SELECT tool,status FROM operations WHERE run_id=?', run.id)).toEqual([{ tool: 'tools_load', status: 'completed' }, { tool: 'workflows_list', status: 'completed' }]);
});
