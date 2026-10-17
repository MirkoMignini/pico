import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { Type } from 'typebox';
import { join } from 'node:path';
import { loadConfig, tokenMatches,atomicWrite } from './config.js';
import { Store, acquireLock, id, json } from './store.js';
import { Runtime } from './runtime.js';
import { validateKnowledge } from './knowledge.js';
import { MEMORY_READING_RULES } from './memory.js';
import { RpcSchema, ConfigSchema, SettingsSchema, ThinkingLevelSchema, MemorySearchSchema, MemoryListSchema, MemoryTagSchema, MemoryTagsSchema, SECRET_NAMES, type Config, type MemorySearch, type ThinkingLevel, validate, type RpcRequest, type Envelope, type OutputEvent, type PicoChannel } from './contracts.js';
import { backup, exportData } from './backup.js';
import { ImageListSchema, ImageIdentitySchema, ImageShowSchema } from './images.js';
import { ScheduleSchema, ScheduleManageSchema, type ScheduleAction } from './scheduler.js';
import { FamilyAddSchema, FamilyMemberSchema } from './family.js';

const object = (properties: Record<string, import('typebox').TSchema>) => Type.Object(properties, { additionalProperties: false });
export async function rpc(runtime: Runtime, request: RpcRequest): Promise<unknown> {
  const args = request.args ?? {};
  const a = <T>(schema: import('typebox').TSchema): T => validate<T>(schema, args);
  const owner: Envelope = { ownerId: runtime.store.config.ownerId, instanceId: runtime.store.config.instanceId, conversationId: '', runId: id(), source: { channel: 'terminal', identity: 'owner-ipc', trustedOwner: true }, mode: 'foreground' };
  switch (request.op) {
    case 'status': a(object({})); return runtime.status();
    case 'settings.get': a(object({}));return loadConfig(runtime.store.root).config;
    case 'settings.update': {const input=a<Record<string,unknown>>(SettingsSchema);const values={...loadConfig(runtime.store.root).config,...input};for(const key of ['thinking','modelThinking','telegram','gmail','embeddings','transcription','speech','search','imageGeneration'])if(values[key as keyof typeof values]===null)delete (values as Record<string,unknown>)[key];const next=validate<Config>(ConfigSchema,values);new Intl.DateTimeFormat('en',{timeZone:next.timezone});if(input.model)runtime.models.model(next.model);if(next.telegram&&!next.telegram.allowedSenders.includes(next.telegram.destination))throw new Error('Telegram destination must be an explicitly allowed owned sender');atomicWrite(join(runtime.store.root,'config.json'),JSON.stringify(next));return {saved:true,restartRequired:true};}
    case 'family.identity': a(object({})); return runtime.family.identity();
    case 'family.add': return runtime.family.add(a(FamilyAddSchema));
    case 'family.revoke': return runtime.family.revoke(a(FamilyMemberSchema));
    case 'family.members': a(object({})); return { members: runtime.family.members() };
    case 'family.receipts': a(object({})); return { requests: runtime.store.all('SELECT peer_id memberId,request_id requestId,direction,action,status,created_at createdAt FROM family_requests ORDER BY created_at DESC,rowid DESC LIMIT 100') };
    case 'channels.list': a(object({})); return runtime.channels.list();
    case 'sessions': a(object({})); return runtime.sessions();
    case 'new': { const input = a<{ title?: string; ephemeral?: boolean }>(object({ title: Type.Optional(Type.String({ maxLength: 120 })), ephemeral: Type.Optional(Type.Boolean()) })); return runtime.newConversation(input.title, input.ephemeral); }
    case 'history': { const input = a<{ conversationId: string }>(object({ conversationId: Type.String() })); return runtime.history(input.conversationId); }
    case 'context.usage': { const input = a<{ conversationId: string }>(object({ conversationId: Type.String() })); return runtime.contextUsage(input.conversationId); }
    case 'instructions.preview': { const input = a<{ conversationId: string }>(object({ conversationId: Type.String() })); return {text:runtime.instructionPreview(input.conversationId)}; }
    case 'instructions.read': { const input = a<{ id: string }>(object({ id: Type.String({minLength:1,maxLength:200}) })); return runtime.readInstructions(input.id); }
    case 'input': return runtime.channels.ingest(owner.source.channel, args, owner.source);
    case 'input.receipt': { const input = a<{ requestId: string }>(object({ requestId: Type.String() })); return runtime.receipt(input.requestId,owner.source); }
    case 'run': { const input = a<{ id: string }>(object({ id: Type.String() })); return runtime.run(input.id); }
    case 'cancel': { const input = a<{ id?: string }>(object({ id: Type.Optional(Type.String()) })); runtime.cancel(input.id); return { cancelled: true, warning: 'Cancellation cannot undo actions already accepted by an external service' }; }
    case 'models': { const input = a<{ available?: boolean }>(object({ available: Type.Optional(Type.Boolean()) })); return (input.available ? await runtime.models.models.getAvailable() : runtime.models.models.getModels()).map(m => ({ provider: m.provider, id: m.id, name: m.name, images: m.input.includes('image'), contextWindow: m.contextWindow })); }
    case 'model': { const input = a<{ conversationId: string; provider: string; id: string }>(object({ conversationId: Type.String(), provider: Type.String(), id: Type.String() })); runtime.model(input.conversationId, input); return { selected: true }; }
    case 'model.default': {const input=a<{provider:string;id:string}>(object({provider:Type.String(),id:Type.String()}));runtime.defaultModel(input);return {updated:true,scope:'New conversations and background work; existing sessions unchanged'};}
    case 'thinking.get': { const input = a<{ conversationId: string }>(object({ conversationId: Type.String() })); return runtime.thinking(input.conversationId); }
    case 'thinking.set': { const input = a<{ conversationId: string; level: ThinkingLevel; persist?: boolean }>(object({ conversationId: Type.String(), level: ThinkingLevelSchema, persist: Type.Optional(Type.Boolean()) })); return runtime.setThinking(input.conversationId, input.level, input.persist ?? false); }
    case 'model.capabilities': {const input=a<{provider:string;id:string}>(object({provider:Type.String(),id:Type.String()}));return runtime.models.capabilities(input);}
    case 'models.refresh': { a(object({})); const result = await runtime.models.models.refresh({ signal: AbortSignal.timeout(30_000) }); return { refreshed: !result.aborted && !result.errors.size, errors: [...result.errors.keys()] }; }
    case 'auth.providers': a(object({})); return runtime.models.providers();
    case 'auth.start': { const input = a<{ provider?: string; type?: 'oauth' | 'api_key'; account?: string }>(object({ provider: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), type: Type.Optional(Type.Union([Type.Literal('oauth'), Type.Literal('api_key')])), account: Type.Optional(Type.String({ pattern: '^[a-z0-9-]{1,40}$' })) })); return runtime.auth.start(input.provider ?? 'openai', input.type ?? 'oauth', input.account); }
    case 'auth.status': { const input = a<{ id?: string }>(object({ id: Type.Optional(Type.String()) })); return runtime.auth.read(input.id); }
    case 'auth.respond': { const input = a<{ id: string; promptId: string; value: string }>(object({ id: Type.String(), promptId: Type.String(), value: Type.String({ maxLength: 8192 }) })); runtime.auth.respond(input.id, input.promptId, input.value); return { accepted: true }; }
    case 'auth.cancel': { const input = a<{ id: string }>(object({ id: Type.String() })); await runtime.auth.cancel(input.id); return { cancelled: true }; }
    case 'auth.logout': { const input = a<{ provider: string }>(object({ provider: Type.String({ minLength: 1, maxLength: 80 }) })); if (runtime.auth.status.state === 'pending') throw new Error('Cancel the pending login before logout'); if (!runtime.models.models.getProvider(input.provider)) throw new Error('Unknown authentication provider'); await runtime.models.models.logout(input.provider); return { loggedOut: true }; }
    case 'auth.key': {
      const input = a<{ provider: string; key: string }>(object({ provider: Type.String({ minLength: 1, maxLength: 80 }), key: Type.String({ minLength: 1, maxLength: 1000 }) }));
      if (!runtime.models.providers().some(provider => provider.id === input.provider && provider.methods.some(method => method.type === 'api_key'))) throw new Error('Invalid input: unsupported API provider');
      if (runtime.auth.status.state === 'pending') throw new Error('Cancel the pending login before saving another credential');
      await runtime.models.login(input.provider, 'api_key', { prompt: async prompt => { if (prompt.type !== 'secret') throw new Error('Use /login for additional provider setup'); return input.key; }, notify() {} });
      return { saved: true, billing: 'metered API usage; no implicit fallback' };
    }
    case 'auth.accounts': a(object({})); return runtime.credentials.list();
    case 'auth.select': { const input = a<{ account: string }>(object({ account: Type.String() })); if (runtime.auth.status.state === 'pending') throw new Error('Cancel the pending login before selecting another account'); await runtime.credentials.selectOpenai(input.account); return { selected: true }; }
    case 'model.answerEvidence': {
      const input = a<{ question: string; evidence: string }>(object({ question: Type.String({ maxLength: 1000 }), evidence: Type.String({ maxLength: 100_000 }) }));
      const response = await runtime.models.complete({ systemPrompt: `${MEMORY_READING_RULES} Answer only from the supplied evidence. No tools or actions.`, messages: [{ role: 'user', content: `Question: ${input.question}\nEvidence: ${input.evidence}`, timestamp: Date.now() }] }, AbortSignal.timeout(30_000));
      return { text: response.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), usage: response.usage };
    }
    case 'auth.preflight': a(object({})); return runtime.models.models.checkAuth(runtime.store.config.model.provider);
    case 'auth.test': { a(object({})); const response = await runtime.models.complete({ messages: [{ role: 'user', content: 'Reply with exactly: Pico is connected.', timestamp: Date.now() }] }, AbortSignal.timeout(30_000)); return { completed: true, content: response.content, usage: response.usage }; }
    case 'secret.status': a(object({})); return Object.fromEntries(await Promise.all(SECRET_NAMES.map(async name => [name, !!await runtime.credentials.secret(name)])));
    case 'secret.set': {
      const input = a<{ name: string; value: string }>(object({ name: Type.Union(SECRET_NAMES.map(value => Type.Literal(value))), value: Type.String({ minLength: 1, maxLength: 4000 }) }));
      if (input.name === 'telegram.token') {
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(input.value)) throw new Error('Invalid Telegram bot token format');
        const previous = await runtime.credentials.secret(input.name);
        // shortcut: Telegram cursors/inbox are single-bot; use another instance until per-bot namespaces exist.
        if (previous && previous.split(':')[0] !== input.value.split(':')[0] && (runtime.store.meta('telegram.offset') !== undefined || runtime.store.config.telegram || loadConfig(runtime.store.root).config.telegram)) throw new Error('Changing Telegram bot identity would reuse another bot\'s inbox. Use a separate Pico instance for a different bot.');
      }
      await runtime.credentials.setSecret(input.name, input.value);
      return { saved: true, restartRequired: input.name === 'telegram.token' };
    }
    case 'web.list': {const input=a<{offset?:number;limit?:number}>(object({offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))}));return {provider:runtime.store.config.search?.provider??'duckduckgo',sources:runtime.store.all('SELECT id,kind,url,title,created_at FROM web_sources ORDER BY created_at DESC,id LIMIT ? OFFSET ?',input.limit??20,input.offset??0)};}
    case 'web.forget': {const input=a<{id:string}>(object({id:Type.String({pattern:'^web:[a-f0-9-]{36}$'})}));return runtime.forget(input.id);}
    case 'knowledge': { const input=validateKnowledge(args);return ['delete','forget'].includes(input.action)?runtime.deleteKnowledge(input.id,input.action==='forget'):runtime.knowledge.operate(input); }
    case 'memory.list': { const input = a<{ status?: string; tags?: string[] }>(MemoryListSchema); return runtime.memory.list(input.status, input.tags); }
    case 'memory.tags': a(object({})); return runtime.memory.tags();
    case 'memory.tag': return runtime.memory.tag(a(MemoryTagSchema));
    case 'memory.search': { const {query,...filters} = a<MemorySearch>(MemorySearchSchema); return runtime.memory.search(query, filters); }
    case 'memory.documentStore':return runtime.promoteDocumentMemory(args);
    case 'memory.retry': a(object({})); return { requeued: runtime.memory.retryExtraction() };
    case 'source.read': {const input=a<{id:string}>(object({id:Type.String()}));const source=runtime.memory.source(input.id,true);if(!source)throw new Error('Source not retained');return source;}
    case 'memory.read': { const input = a<{ id: string }>(object({ id: Type.String() })); return runtime.memory.read(input.id); }
    case 'memory.remember': { const input = a<{ key: string; value: string; scope?: string; kind?: 'fact' | 'preference'; entity?: string; tags?: string[] }>(object({ key: Type.String({ minLength: 1, maxLength: 200 }), value: Type.String({ minLength: 1, maxLength: 4000 }), scope: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal('fact'),Type.Literal('preference')])), entity: Type.Optional(Type.String()), tags: Type.Optional(MemoryTagsSchema) })); return runtime.remember(input.key, input.value, input.scope, input.kind, input.entity, input.tags); }
    case 'memory.forget': { const input = a<{ id: string }>(object({ id: Type.String() })); return runtime.forget(input.id); }
    case 'memory.rebuild': a(object({})); runtime.memory.rebuild(); return { rebuilt: true, embeddings: 'pending background rebuild if configured' };
    case 'schedules.list': a(object({})); return runtime.scheduler.list();
    case 'schedules.history': { const input = a<{ id?: string }>(object({ id: Type.Optional(Type.String()) })); return runtime.scheduler.history(input.id); }
    case 'schedules.create': { const input = a<{ definition: unknown; original: string }>(object({ definition: ScheduleSchema, original: Type.String({ maxLength: 8000 }) })); return runtime.scheduler.create(input.definition, input.original); }
    case 'schedules.manage': { const input = a<{ id: string; action: ScheduleAction; definition?: unknown }>(ScheduleManageSchema); return { ...runtime.manageSchedule(input.id, input.action, input.definition), updated: true }; }
    case 'notifications.list': a(object({})); return runtime.store.all('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100');
    case 'notifications.retry': { const input = a<{ id: string }>(object({ id: Type.String() })); runtime.scheduler.retry(input.id); return { queued: true, warning: 'At-least-once retry may duplicate an accepted send' }; }
    case 'notifications.feedback': {
      const input=a<{id:string;useful:boolean}>(object({id:Type.String(),useful:Type.Boolean()}));
      const ruleId=input.id.startsWith('mail:')?input.id.split(':')[1]:undefined;
      return runtime.store.transaction(()=>{
        runtime.store.run('INSERT OR REPLACE INTO feedback VALUES(?,?,?)',input.id,Number(input.useful),Date.now());
        const paused=!input.useful&&ruleId?runtime.store.run('UPDATE notification_rules SET paused=1 WHERE id=?',ruleId)>0:false;
        return {saved:true,matchedMailRulePaused:paused};
      });
    }
    case 'images.preview': return runtime.images.preview(a(ImageShowSchema));
    case 'images.previews': { const input=a<{conversationId:string;runId?:string}>(object({conversationId:Type.String({minLength:1,maxLength:200}),runId:Type.Optional(Type.String({minLength:1,maxLength:200}))}));runtime.conversation(input.conversationId);return runtime.images.previews(input.conversationId,input.runId); }
    case 'images.list': return runtime.images.list(a(ImageListSchema));
    case 'images.read': { const input=a<{id:string}>(ImageIdentitySchema);return runtime.images.read(input.id); }
    case 'images.forget': { const input=a<{id:string}>(ImageIdentitySchema);return runtime.forget(`image:${input.id}`); }
    case 'attachments.upload': { const input = a<{ name: string; mime: string; data: string; conversationId?: string; ephemeral?: boolean }>(object({ name: Type.String({ maxLength: 120 }), mime: Type.String({ maxLength: 100 }), data: Type.String({ maxLength: runtime.store.config.limits.attachmentBytes * 2 }), conversationId: Type.Optional(Type.String()), ephemeral: Type.Optional(Type.Boolean()) })); if (input.conversationId) runtime.conversation(input.conversationId); return { id: runtime.media.save(Buffer.from(input.data,'base64'), input.name, input.mime, input.conversationId, !!input.ephemeral || !!input.conversationId && runtime.isEphemeral(input.conversationId)) }; }
    case 'extensions.list': a(object({})); return runtime.extensions.list();
    case 'extensions.setup': { const input=a<{id:string}>(object({id:Type.String()}));return runtime.extensions.setup(input.id); }
    case 'extensions.configure': { const input=a<{id:string;settings:unknown}>(object({id:Type.String(),settings:Type.Unknown()}));if(!runtime.canApplySettings)throw new Error('Wait for active work before changing integration settings');await runtime.extensions.configure(input.id,input.settings);return {saved:true}; }
    case 'extensions.secret': { const input=a<{id:string;name:string;value:string}>(object({id:Type.String(),name:Type.String(),value:Type.String({minLength:1,maxLength:16_000})}));if(!runtime.canApplySettings)throw new Error('Wait for active work before changing integration credentials');await runtime.extensions.setupSecret(input.id,input.name,input.value);return {saved:true}; }
    case 'extensions.discover': a(object({})); return runtime.extensions.discover();
    case 'extensions.validate': { const input = a<{ module: unknown }>(object({ module: Type.Unknown() })); return runtime.extensions.validateModule(input.module); }
    case 'extensions.review': { const input = a<{ id: string }>(object({ id: Type.String() })); return runtime.extensions.review(input.id); }
    case 'extensions.approve': { const input = a<{ id: string; hash: string; decision: boolean }>(object({ id: Type.String(), hash: Type.String(), decision: Type.Boolean() })); if(!runtime.canApplySettings)throw new Error('Wait for active work before loading trusted code'); await runtime.extensions.approve(input.id, input.hash, input.decision, owner); return { approved: input.decision, execution: runtime.extensions.status }; }
    case 'extensions.disable': { const input = a<{ id: string }>(object({ id: Type.String() })); if(!runtime.canApplySettings)throw new Error('Wait for active work before unloading trusted code'); await runtime.extensions.disable(input.id); return { disabled: true }; }
    case 'extensions.enable': { const input = a<{ id: string }>(object({ id: Type.String() })); if (!runtime.canApplySettings) throw new Error('Wait for active work before loading trusted code'); await runtime.extensions.enable(input.id); return { enabled: true }; }
    case 'extensions.rollback': { const input = a<{ id: string }>(object({ id: Type.String() })); if(!runtime.canApplySettings)throw new Error('Wait for active work before replacing trusted code'); await runtime.extensions.rollback(input.id); return { rolledBack: true, state: 'Namespaced storage preserved; code rollback does not undo writes' }; }
    case 'extensions.invoke': { const input = a<{ id: string; input: unknown }>(object({ id: Type.String(), input: Type.Unknown() })); return runtime.invokeExtension(input.id, input.input, owner); }
    case 'backup': a(object({})); return backup(runtime.store);
    case 'export': a(object({})); return exportData(runtime.store);
    default: return runtime.extensionRpc(request.op, args, owner);
  }
}
async function body(request: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > max) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function serve(path: string, options: { runtimeFactory?: (store: Store) => Runtime;
  channels?: (runtime: Runtime) => Iterable<PicoChannel> | Promise<Iterable<PicoChannel>> } = {}): Promise<{ runtime: Runtime; server: Server; close: () => Promise<void> }> {
  const { root, config, token, socket } = loadConfig(path);
  const unlock = acquireLock(root);
  let store: Store;
  try { store = new Store(root, config); } catch (error) { unlock(); throw error; }
  let runtime = options.runtimeFactory?.(store) ?? new Runtime(store);
  const prepare = async (target: Runtime) => {
    for (const channel of await options.channels?.(target) ?? []) target.channels.register(channel);
  };
  let applying = false, requests = 0;
  const streams = new Set<ServerResponse>();
  const broadcast = (event: OutputEvent) => {
    for (const stream of streams) { if (stream.writableLength > 1_000_000) { stream.destroy(); streams.delete(stream); } else stream.write(`data: ${json(event)}\n\n`); }
  };
  runtime.events.on('output', broadcast);
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/family') {
      if (closed || applying) { response.writeHead(503).end(); return; }
      requests++;
      const timeout = setTimeout(() => request.destroy(), 5000);
      void (async () => {
        try {
          const result = await runtime.family.receive(await body(request, 100_000));
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(json(result));
        } catch { response.writeHead(401, { 'Cache-Control': 'no-store' }).end('Family request refused'); }
        finally { clearTimeout(timeout); requests--; }
      })();
      return;
    }
    if (!tokenMatches(request.headers.authorization?.replace(/^Bearer /, '') ?? '', token)) { response.writeHead(401).end('Unauthorized'); return; }
    if (request.method === 'GET' && request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); response.write(': connected\n\n');
      streams.add(response); request.on('close', () => streams.delete(response)); return;
    }
    if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404).end(); return; }
    if (applying) { response.writeHead(503, { 'Content-Type': 'application/json' }).end(json({ ok: false, error: 'Settings are being applied; wait before submitting a new operation' })); return; }
    requests++;
    void (async () => {
      try {
        const input = validate<RpcRequest>(RpcSchema, await body(request, config.limits.attachmentBytes * 2 + 100_000));
        const result = input.op === 'settings.apply' ? (validate(object({}), input.args ?? {}), await apply()) : await rpc(runtime, input);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(json({ ok: true, result: result ?? null }));
      } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(json({ ok: false, error: error instanceof Error ? error.message.slice(0, 8000) : 'Request failed' })); }
      finally { requests--; }
    })();
  });
  server.requestTimeout = 330_000;
  if (existsSync(socket)) unlinkSync(socket);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    while (applying) await new Promise(resolve => setTimeout(resolve, 10));
    try { await runtime.close(); }
    finally {
      runtime.events.off('output', broadcast);
      for (const stream of streams) stream.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (existsSync(socket)) unlinkSync(socket); store.close(); unlock();
    }
  };
  const apply = async () => {
    if (closed || requests > 1 || !runtime.canApplySettings) throw new Error('Wait for active operations, queued turns and pending browser sign-ins to finish before applying settings');
    const next = loadConfig(root).config;
    if (next.ownerId !== config.ownerId || next.instanceId !== config.instanceId) throw new Error('Settings cannot change the owner or instance identity');
    applying = true;
    let candidate: Runtime | undefined, candidateStore: Store | undefined, stopped = false;
    try {
      candidateStore = new Store(root, next);
      candidate = options.runtimeFactory?.(candidateStore) ?? new Runtime(candidateStore);
      await prepare(candidate);
      if (closed || !runtime.canApplySettings) throw new Error('Wait for active work and pending sign-ins to finish before applying settings');
      stopped = true; await runtime.close();
      candidate.events.on('output', broadcast);
      await candidate.start();
      runtime.events.off('output', broadcast); store.close();
      store = candidateStore; runtime = candidate;
      runtime.emit({ type: 'status', data: { settingsApplied: true, ephemeralSessionsLost: true } });
      return { applied: true, warning: 'Ephemeral sessions were discarded; retained conversations and schedules are preserved' };
    } catch {
      candidate?.events.off('output', broadcast);
      try { await candidate?.close(); } catch { throw new Error('Settings application cleanup failed. No replacement was started; an operator restart is required.'); }
      candidateStore?.close();
      if (stopped && !closed) {
        runtime.events.off('output', broadcast);
        try {
          runtime = options.runtimeFactory?.(store) ?? new Runtime(store);
          await prepare(runtime); runtime.events.on('output', broadcast); await runtime.start();
        } catch { throw new Error('The previous backend could not be restored. Correct the saved settings and ask the operator to restart Pico.'); }
      }
      throw new Error('Settings could not be applied. Saved settings remain pending; correct them in /settings and try again.');
    } finally { applying = false; }
  };
  try {
    await prepare(runtime);
    await runtime.start();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); chmodSync(socket, 0o600);
  } catch (error) { await close(); throw error; }
  return { get runtime() { return runtime; }, server, close };
}
