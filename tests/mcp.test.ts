import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { rpc } from '../src/daemon.js';
import { mcpSettings, type McpServer } from '../src/mcp-contracts.js';
import { mcpFetch } from '../src/mcp-network.js';
import { mcpToolName } from '../src/mcp.js';
import type { Envelope } from '../src/contracts.js';
import { setup, source, waitFor, reply, loadTools } from './helpers.js';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { fixture } from './fixtures/mcp-server.mjs';
import { modernFixture } from './fixtures/mcp-modern-server.mjs';

const instances: ReturnType<typeof setup>[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
const executable = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const owner = (s: ReturnType<typeof setup>): Envelope => ({ ownerId: s.config.ownerId, instanceId: s.config.instanceId, runId: crypto.randomUUID(), conversationId: '', source, mode: 'foreground' });
const invoke = <T = any>(s: ReturnType<typeof setup>, name: string, args: Record<string, unknown> = {}): Promise<T> => rpc(s.runtime, { op: `extensions.mcp.${name}`, args }) as Promise<T>;
async function instance(config?: Partial<McpServer>, args: string[] = []) {
  const s = setup('synthetic-mcp'); instances.push(s); await s.runtime.start();
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ id: 'fixture', enabled: true, ...(config?.transport && config.transport !== 'stdio' ? {} : { transport: 'stdio', command: process.execPath, args: [executable, ...args] }), readOnlyTools: ['read.echo', 'inspect', 'ask.form', 'ask.sample', 'fail', 'large', 'wait', 'change_catalog', 'bad_output'], ...config }] } } });
  await invoke(s, 'connect', { server: 'fixture' }); return s;
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('validates strict MCP configuration, credential separation and one-process stdio negotiation', () => {
  const valid = { id: 'fixture', enabled: true, transport: 'stdio', command: process.execPath };
  expect(mcpSettings({ servers: [valid] }).servers).toHaveLength(1);
  for (const servers of [[valid, valid], [{ ...valid, surprise: true }], [{ ...valid, protocol: 'modern' }], [{ ...valid, env: { API_KEY: 'not-a-key' } }], [{ ...valid, roots: [{ uri: 'https://example.com' }] }], [{ id: 'remote', enabled: true, transport: 'http', url: 'https://user:password@example.com/mcp' }], [{ id: 'remote', enabled: true, transport: 'http', url: 'https://example.com/mcp?api_key=not-a-key' }], [{ id: 'remote', enabled: true, transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'not-a-key' } }]]) expect(() => mcpSettings({ servers })).toThrow();
  expect(mcpToolName('fixture', 'a-b')).not.toBe(mcpToolName('fixture', 'a_b'));
  expect(mcpToolName('x'.repeat(32), 'y'.repeat(256))).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
});

it('uses the official SDK over a real stdio child, pages discovery and registers namespaced tools', async () => {
  const s = await instance();
  const status = await invoke(s, 'status');
  expect(status.servers[0]).toMatchObject({ state: 'connected', tools: 10, resources: 2, prompts: 1, implementation: { name: 'pikobot-synthetic-mcp' } });
  const catalog = await invoke(s, 'catalog', { server: 'fixture', kind: 'tools', limit: 1 });
  expect(catalog).toMatchObject({ total: 10, nextOffset: 1, entries: [{ name: 'read.echo', policy: 'owner-declared-read', inputSchema: { additionalProperties: false } }] });
  expect(s.runtime.extensions.tools().some(tool => tool.name === mcpToolName('fixture', 'read.echo'))).toBe(true);
  expect(await invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'hello' } })).toMatchObject({ origin: 'external:mcp:fixture', structuredContent: { text: 'hello' } });
  expect(s.store.get("SELECT status FROM operations WHERE tool='mcp_call' ORDER BY created_at DESC LIMIT 1")).toEqual({ status: 'completed' });
  await expect(invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 42 } })).rejects.toThrow('input schema');
  await expect(invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'hello', extra: true } })).rejects.toThrow('input schema');
});

it('supports resources, binary contents, templates, prompt arguments, completion and subscriptions', async () => {
  const s = await instance();
  expect(await invoke(s, 'resource', { server: 'fixture', uri: 'fixture://hello/alpha' })).toMatchObject({ contents: [{ text: 'Synthetic resource fixture://hello/alpha' }] });
  expect(await invoke(s, 'resource', { server: 'fixture', uri: 'fixture://binary' })).toMatchObject({ contents: [{ blob: Buffer.from('synthetic binary').toString('base64') }] });
  expect(await invoke(s, 'catalog', { kind: 'templates' })).toMatchObject({ total: 1, entries: [{ uriTemplate: 'fixture://hello/{name}' }] });
  expect(await invoke(s, 'prompt', { server: 'fixture', name: 'explain', arguments: { subject: 'colors' } })).toMatchObject({ messages: [{ role: 'user', content: { text: 'Explain colors' } }], warning: expect.stringContaining('untrusted') });
  expect(await invoke(s, 'complete', { server: 'fixture', ref: { type: 'ref/prompt', name: 'explain' }, argument: { name: 'subject', value: 'al' } })).toMatchObject({ completion: { values: ['alpha', 'alpine'] } });
  expect(await invoke(s, 'resource', { server: 'fixture', uri: 'fixture://hello', action: 'subscribe' })).toMatchObject({ subscribed: true });
  await waitFor(() => s.runtime.extensions.status.loaded.includes('mcp'));
  expect((await invoke(s, 'status')).servers[0].notifications.some((event: any) => event.type === 'resource_updated')).toBe(true);
  expect(await invoke(s, 'resource', { server: 'fixture', uri: 'fixture://hello', action: 'unsubscribe' })).toMatchObject({ subscribed: false });
  expect(await invoke(s, 'ping', { server: 'fixture' })).toEqual({});
  expect(await invoke(s, 'logging', { server: 'fixture', level: 'warning' })).toEqual({});
});

it('never trusts readOnlyHint; exact single-use terminal approvals precede real remote writes', async () => {
  const s = await instance();
  const prepared = await invoke(s, 'call', { server: 'fixture', name: 'write.record', arguments: { text: 'one' } });
  expect(prepared.prepared).toBe(true);
  const inspect = () => invoke(s, 'call', { server: 'fixture', name: 'inspect', arguments: { text: '' } });
  expect(JSON.parse((await inspect()).content[0].text).effects).toBe(0);
  await expect(invoke(s, 'actions.approve', { id: prepared.action.id, digest: '0'.repeat(64), decision: true })).rejects.toThrow('Changed');
  const accepted = await invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true });
  expect(accepted).toMatchObject({ status: 'accepted' });
  expect(JSON.parse((await inspect()).content[0].text).effects).toBe(1);
  await expect(invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true })).rejects.toThrow('consumed');
  expect(JSON.parse((await inspect()).content[0].text).effects).toBe(1);
});

it('invalidates prepared actions on disconnect and refuses MCP in all restricted contexts', async () => {
  const s = await instance(), prepared = await invoke(s, 'call', { server: 'fixture', name: 'write.record', arguments: { text: 'one' } });
  await invoke(s, 'disconnect', { server: 'fixture' }); await invoke(s, 'connect', { server: 'fixture' });
  await expect(invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true })).rejects.toThrow('Connection');
  const context = owner(s);
  for (const invalid of [{ ...context, mode: 'ephemeral' as const }, { ...context, mode: 'scheduled' as const }, { ...context, mode: 'review' as const }, { ...context, source: { ...source, trustedOwner: false } }]) await expect(s.runtime.extensions.invoke('mcp_call', { server: 'fixture', name: 'read.echo', arguments: { text: 'denied' } }, invalid, 'denied-call', async () => { throw new Error('Unexpected tool'); }, undefined, undefined, undefined, true)).rejects.toThrow();
  await expect(s.runtime.extensions.invoke('mcp_status', {}, context, 'repair-denied', async () => { throw new Error('Unexpected tool'); }, undefined, undefined, undefined, false)).rejects.toThrow('restricted execution');
  expect((await invoke(s, 'actions.review', { id: prepared.action.id })).status).toBe('pending');
});

it('scrubs ambient credentials, uses a disposable HOME and redacts configured secrets before retention', async () => {
  vi.stubEnv('PIKOBOT_MCP_AMBIENT_TOKEN', 'ambient-fixture');
  const s = await instance();
  await invoke(s, 'disconnect', { server: 'fixture' });
  await rpc(s.runtime, { op: 'extensions.secret', args: { id: 'mcp', name: 'fixture', value: JSON.stringify({ env: { OPERATOR_TOKEN: 'synthetic-quoted-"-token' } }) } });
  await invoke(s, 'connect', { server: 'fixture' });
  const result = await invoke(s, 'call', { server: 'fixture', name: 'inspect', arguments: { text: '' } });
  const details = JSON.parse(result.content[0].text);
  expect(details).toMatchObject({ inherited: null, secret: '[redacted]' });
  expect(details.home).not.toBe(process.env.HOME); expect(existsSync(details.home)).toBe(true);
  if (process.platform === 'darwin') expect(Buffer.byteLength(details.home)).toBeLessThan(40); // Leave room for browser Unix-socket suffixes.
  expect(JSON.stringify(s.store.all('SELECT result FROM operations'))).not.toContain('synthetic-quoted');
  await invoke(s, 'disconnect', { server: 'fixture' }); expect(existsSync(details.home)).toBe(false);
});

it('bounds results and pagination and reports tool/schema failures instead of success', async () => {
  const s = await instance({ maxBytes: 6000 });
  await expect(invoke(s, 'call', { server: 'fixture', name: 'large', arguments: { text: '' } })).rejects.toThrow();
  await invoke(s, 'disconnect', { server: 'fixture' });
  await invoke(s, 'connect', { server: 'fixture' });
  await expect(invoke(s, 'call', { server: 'fixture', name: 'fail', arguments: { text: '' } })).rejects.toThrow('reported an error');
  const bad = setup('bad-mcp'); instances.push(bad); await bad.runtime.start();
  await rpc(bad.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ id: 'fixture', enabled: true, transport: 'stdio', command: process.execPath, args: [executable, '--repeat'] }] } } });
  await expect(invoke(bad, 'connect', { server: 'fixture' })).rejects.toThrow('discovery failed');
  expect((await invoke(bad, 'status')).servers[0]).toMatchObject({ state: 'error', tools: 0 });
  const invalid = await instance({}, ['--invalid-output']);
  await expect(invoke(invalid, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'invalid' } })).rejects.toThrow();
});

it('refreshes changed tool catalogs without restarting Pikobot or inheriting an old approval', async () => {
  const s = await instance();
  await invoke(s, 'call', { server: 'fixture', name: 'change_catalog', arguments: { text: '' } });
  expect(await invoke(s, 'catalog', { kind: 'tools', limit: 100 })).toMatchObject({ total: 11 });
  expect(s.runtime.extensions.tools().some(tool => tool.name === mcpToolName('fixture', 'added'))).toBe(true);
});

it('elicits only a one-use owner-terminal response during the original active call', async () => {
  const s = await instance({ elicitation: true, timeoutMs: 10_000 });
  const call = invoke(s, 'call', { server: 'fixture', name: 'ask.form', arguments: { text: '' } });
  let pending: any;
  await waitFor(() => s.store.all("SELECT id FROM operations WHERE tool='mcp_call'").length > 0);
  for (let attempt = 0; attempt < 100; attempt++) { pending = (await invoke(s, 'requests'))[0]; if (pending) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(pending).toMatchObject({ kind: 'elicitation' });
  const review = await invoke(s, 'requests.read', { id: pending.id });
  await expect(invoke(s, 'requests.respond', { id: review.id, digest: review.digest, action: 'accept', content: {} })).rejects.toThrow('schema');
  await invoke(s, 'requests.respond', { id: review.id, digest: review.digest, action: 'accept', content: { color: 'blue' } });
  expect(JSON.parse((await call).content[0].text)).toMatchObject({ action: 'accept', content: { color: 'blue' } });
  await expect(invoke(s, 'requests.respond', { id: review.id, digest: review.digest, action: 'accept', content: { color: 'blue' } })).rejects.toThrow('consumed');
});

it('requires explicit sampling approval, makes one faux model call and sends no private context', async () => {
  const s = await instance({ sampling: true, timeoutMs: 10_000 }); reply(s.faux, 'synthetic sampled hello');
  const call = invoke(s, 'call', { server: 'fixture', name: 'ask.sample', arguments: { text: '' } });
  let requests: any[] = [];
  for (let attempt = 0; attempt < 100; attempt++) { requests = await invoke(s, 'requests'); if (requests.length) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(requests).toHaveLength(1); expect(s.faux.state.callCount).toBe(0);
  const review = await invoke(s, 'requests.read', { id: requests[0].id });
  await invoke(s, 'requests.respond', { id: review.id, digest: review.digest, action: 'accept' });
  expect(JSON.parse((await call).content[0].text)).toMatchObject({ content: { text: 'synthetic sampled hello' } });
  expect(s.faux.state.callCount).toBe(1);
});

it('cancels a real stdio call and kills only its owned server process group on disconnect', async () => {
  const s = setup('cancel-mcp'); instances.push(s); const marker = join(s.root, 'child-pid'); await s.runtime.start();
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ id: 'fixture', enabled: true, transport: 'stdio', command: process.execPath, args: [executable, '--grandchild', '--marker', marker], readOnlyTools: ['inspect', 'wait'], timeoutMs: 10_000 }] } } });
  await invoke(s, 'connect', { server: 'fixture' });
  const childPid = Number(readFileSync(marker, 'utf8').trim()); expect(childPid).toBeGreaterThan(0);
  const controller = new AbortController(), context = owner(s);
  const call = s.runtime.extensions.invoke('mcp_call', { server: 'fixture', name: 'wait', arguments: { text: '' } }, context, 'synthetic-call', async () => { throw new Error('Unexpected nested tool'); }, controller.signal, undefined, undefined, true).catch(error => error);
  await waitFor(() => readFileSync(marker, 'utf8').includes('waiting'));
  controller.abort(new Error('synthetic cancellation')); expect(await call).toBeInstanceOf(Error);
  await invoke(s, 'disconnect', { server: 'fixture' });
  await waitFor(() => { try { process.kill(childPid, 0); return false; } catch { return true; } });
  expect((await invoke(s, 'status')).servers[0].state).toBe('not_connected');
});

it('keeps async MCP task creation behind exact approval even for an autonomous tool grant', async () => {
  const s = await instance({ tools: ['write.record'], readOnlyTools: [], autonomousTools: ['write.record'] });
  const prepared = await invoke(s, 'call', { server: 'fixture', name: 'write.record', arguments: { text: 'synthetic async task' }, task: { ttl: 60000 } });
  expect(prepared.prepared).toBe(true);
  expect(s.store.all("SELECT id FROM operations WHERE tool='mcp_autonomous'")).toEqual([]);
});

it('supports experimental legacy tasks, with terminal approval for creation and cancellation', async () => {
  const s = await instance();
  expect(await invoke(s, 'tasks', { server: 'fixture', action: 'list' })).toMatchObject({ tasks: [{ taskId: 'synthetic-task' }] });
  expect(await invoke(s, 'tasks', { server: 'fixture', action: 'get', taskId: 'synthetic-task' })).toMatchObject({ status: 'completed' });
  expect(await invoke(s, 'tasks', { server: 'fixture', action: 'result', taskId: 'synthetic-task' })).toMatchObject({ content: [{ text: 'task finished' }] });
  const prepared = await invoke(s, 'call', { server: 'fixture', name: 'write.record', arguments: { text: 'task' }, task: { ttl: 60000 } });
  expect(await invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true })).toMatchObject({ status: 'accepted', result: { task: { taskId: 'synthetic-task' } } });
  const cancel = await invoke(s, 'tasks', { server: 'fixture', action: 'cancel', taskId: 'synthetic-task' });
  expect(await invoke(s, 'actions.approve', { id: cancel.action.id, digest: cancel.action.digest, decision: true })).toMatchObject({ status: 'accepted', result: { status: 'cancelled' } });
});

it('uses actual Streamable HTTP with explicit private networking, while default SSRF/redirect protections stay closed', async () => {
  const handler = createMcpHandler(() => modernFixture(), { legacy: 'reject' });
  let requests = 0;
  const http = createServer(async (request, response) => {
    requests++;
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://127.0.0.1/private' }).end(); return; }
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await handler.fetch(new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: request.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); if (result.body) Readable.fromWeb(result.body as any).pipe(response); else response.end();
    } catch { response.writeHead(500).end(); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  cleanups.push(async () => { await handler.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const port = (http.address() as { port: number }).port, url = `http://127.0.0.1:${port}/mcp`;
  const config: McpServer = { id: 'http', enabled: true, transport: 'http', url };
  await expect(mcpFetch(config, new AbortController().signal)(url, { method: 'GET' })).rejects.toThrow(); expect(requests).toBe(0);
  await expect(mcpFetch({ ...config, allowPrivateNetwork: true }, new AbortController().signal)(`http://127.0.0.1:${port}/redirect`)).rejects.toThrow('redirect');
  const s = await instance({ transport: 'http', url, allowPrivateNetwork: true });
  expect(await invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'real-http' } })).toMatchObject({ structuredContent: { text: 'real-http' } });
  expect((await invoke(s, 'status')).servers[0].protocol).toMatch(/^2026-/);
  handler.notify.toolsChanged();
  let notified = false;
  for (let attempt = 0; attempt < 100 && !notified; attempt++) { notified = (await invoke(s, 'status')).servers[0].notifications.some((event: any) => event.type === 'notifications/tools/list_changed'); if (!notified) await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(notified).toBe(true);
});

it('negotiates modern stdio in place without starting a disposable second process', async () => {
  const s = setup('mcp-one-process'); instances.push(s); await s.runtime.start(); const marker = join(s.root, 'starts');
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ id: 'fixture', enabled: true, transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-modern-server.mjs', import.meta.url)), '--marker', marker], protocol: 'auto', readOnlyTools: ['read.echo'] }] } } });
  await invoke(s, 'connect', { server: 'fixture' });
  expect((await invoke(s, 'status')).servers[0].protocol).toMatch(/^2026-/);
  expect(readFileSync(marker, 'utf8')).toBe('started\n');
  expect(await invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'modern-stdio' } })).toMatchObject({ structuredContent: { text: 'modern-stdio' } });
});

it('connects to an actual legacy HTTP/SSE endpoint and exchanges tool calls', async () => {
  const server = fixture(); let receiver: any; let stream: import('node:http').ServerResponse | undefined;
  const transport: import('@modelcontextprotocol/client').Transport = {
    start: async () => { stream!.write('event: endpoint\ndata: /messages\n\n'); },
    send: async message => { stream!.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`); },
    close: async () => { stream?.end(); }
  };
  const http = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/sse') { stream = response; response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); await server.connect(transport); receiver = transport.onmessage; return; }
    if (request.method === 'POST' && request.url === '/messages') { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); response.writeHead(202).end(); receiver(JSON.parse(Buffer.concat(chunks).toString())); return; }
    response.writeHead(404).end();
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  cleanups.push(async () => { await server.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const s = await instance({ transport: 'sse', url: `http://127.0.0.1:${(http.address() as { port: number }).port}/sse`, allowPrivateNetwork: true });
  expect(await invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'real-sse' } })).toMatchObject({ structuredContent: { text: 'real-sse' } });
});

it('keeps a real accepted write uncertain after its server exits without acknowledgement, never replaying it', async () => {
  const s = await instance(), marker = join(s.root, 'remote-effects');
  const current = await rpc(s.runtime, { op: 'extensions.setup', args: { id: 'mcp' } }) as any;
  current.settings.servers[0].args.push('--marker', marker);
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: current.settings } });
  await invoke(s, 'connect', { server: 'fixture' });
  const prepared = await invoke(s, 'call', { server: 'fixture', name: 'write.record', arguments: { text: 'lost-ack' } });
  const decision = { id: prepared.action.id, digest: prepared.action.digest, decision: true };
  expect(await invoke(s, 'actions.approve', decision)).toMatchObject({ status: 'uncertain' });
  expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
  await expect(invoke(s, 'actions.approve', decision)).rejects.toThrow('consumed');
  await invoke(s, 'connect', { server: 'fixture' });
  expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(s.store.get("SELECT status FROM operations WHERE tool='mcp_approved'")).toEqual({ status: 'uncertain' });
});

it('runs a namespaced MCP tool through the actual agent with a faux model and canonical receipts', async () => {
  const s = await instance(), name = mcpToolName('fixture', 'read.echo');
  s.faux.appendResponses([loadTools(name), fauxAssistantMessage([fauxToolCall(name, { arguments: { text: 'agent MCP' } })]), fauxAssistantMessage([fauxText('Synthetic MCP completed.')])]);
  const conversation = s.runtime.newConversation(), run = await s.runtime.ingest({ requestId: 'mcp-faux-run', conversationId: conversation.id, text: 'Echo agent MCP through the selected server' }, source);
  await waitFor(() => ['completed', 'failed'].includes(s.runtime.run(run.id).status));
  expect(s.runtime.run(run.id)).toMatchObject({ status: 'completed', partial: 'Synthetic MCP completed.' });
  expect(s.store.get('SELECT status FROM operations WHERE run_id=? AND tool=?', run.id, name)).toEqual({ status: 'completed' });
});

it('recovers large read/write results from complete receipts without repeating the external action', async () => {
  const s = await instance();
  const preview = await invoke(s, 'call', { server: 'fixture', name: 'large', arguments: { text: '' } });
  expect(preview).toMatchObject({ truncated: true, originalResultSourceId: expect.any(String) });
  const source = await rpc(s.runtime, { op: 'source.read', args: { id: preview.originalResultSourceId } }) as { text: string };
  expect(JSON.parse(JSON.parse(source.text).content[0].text).content[0].text.length).toBe(30000);
  const prepared = await invoke(s, 'call', { server: 'fixture', name: 'write.record', arguments: { text: 'large-ack' } });
  const action = await invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true });
  expect(action).toMatchObject({ status: 'accepted', result: { contentOmitted: true, originalResultSourceId: expect.any(String) } });
  const receipt = await rpc(s.runtime, { op: 'source.read', args: { id: action.result.originalResultSourceId } }) as { text: string };
  expect(JSON.parse(JSON.parse(JSON.parse(receipt.text).content[0].text).content[0].text)).toMatchObject({ effects: 1, payload: 'x'.repeat(200000) });
  await expect(invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true })).rejects.toThrow('consumed');
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_approved'")).toEqual({ count: 1 });
});

it('blocks stale live credentials and respects owner-selected tool/resource/prompt restrictions', async () => {
  const s = await instance({ tools: ['read.echo'], resources: false, prompts: false });
  await expect(invoke(s, 'call', { server: 'fixture', name: 'inspect', arguments: { text: '' } })).rejects.toThrow('not enabled');
  await expect(invoke(s, 'resource', { server: 'fixture', uri: 'fixture://hello' })).rejects.toThrow('disabled');
  await expect(invoke(s, 'prompt', { server: 'fixture', name: 'explain' })).rejects.toThrow('disabled');
  await expect(invoke(s, 'complete', { server: 'fixture', ref: { type: 'ref/prompt', name: 'explain' }, argument: { name: 'subject', value: '' } })).rejects.toThrow('disabled');
  await rpc(s.runtime, { op: 'extensions.secret', args: { id: 'mcp', name: 'fixture', value: '{"env":{"OPERATOR_TOKEN":"synthetic-changed"}}' } });
  await expect(invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'stale' } })).rejects.toThrow('credentials changed');
  await invoke(s, 'disconnect', { server: 'fixture' }); await invoke(s, 'connect', { server: 'fixture' });
  expect(await invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'fresh' } })).toMatchObject({ structuredContent: { text: 'fresh' } });
});
