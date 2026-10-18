import { Type, type TSchema, type Static } from 'typebox';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Store, id, json, hash } from './store.js';
import { object, validate, SECRET_NAMES, type Envelope, type PicoChannel } from './contracts.js';
import type { Credentials } from './credentials.js';
import type { Channels } from './channels.js';
import type { ExtensionServices, BackgroundContext } from './extension-services.js';
import { instant } from './time.js';
import type { ToolHistoryPolicy } from './tool-context.js';

export interface ExtensionContext extends Readonly<Envelope> {
  readonly services: ExtensionServices;
  readonly writesAllowed: boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult>;
}
export interface ExtensionTool<T extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  history?: ToolHistoryPolicy;
  trustedOnly?: boolean;
  execute(callId: string, params: Static<T>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback | undefined, context: ExtensionContext): Promise<AgentToolResult>;
}
export interface ExtensionRpc<T extends TSchema = TSchema> {
  name: string;
  parameters: T;
  execute(params: Static<T>, context: ExtensionContext): Promise<unknown>;
}
export interface ExtensionSetup {
  title: string;
  description: string;
  parameters: TSchema;
  read(): unknown;
  save(settings: unknown): void | Promise<void>;
  secrets: { name: string; label: string }[];
  prepareSecret?(name: string, value: string): string;
}
export interface AgendaEntry { id: string; title: string; at: string; end?: string; allDay?: boolean; origin: string; url?: string; location?: string }
export interface AgendaContribution { items: AgendaEntry[]; truncated: boolean; warnings: string[] }
const AgendaContributionSchema=object({items:Type.Array(object({id:Type.String({minLength:1,maxLength:500}),title:Type.String({maxLength:1000}),at:Type.String({maxLength:40}),end:Type.Optional(Type.String({maxLength:40})),allDay:Type.Optional(Type.Boolean()),origin:Type.String({minLength:1,maxLength:300}),url:Type.Optional(Type.String({maxLength:2000})),location:Type.Optional(Type.String({maxLength:1000}))}),{maxItems:1000}),truncated:Type.Boolean(),warnings:Type.Array(Type.String({maxLength:1000}),{maxItems:100})});
interface Events {
  agenda: (range: { from: string; to: string; timezone: string }, context: Readonly<Envelope>, signal?: AbortSignal) => Promise<AgendaContribution>;
  instructions: (context: Readonly<Envelope>) => string;
  start: () => void | Promise<void>;
  shutdown: () => void | Promise<void>;
  background: (context: BackgroundContext) => void | Promise<void>;
  settled: (runId: string) => void | Promise<void>;
  busy: () => boolean;
}
export interface ExtensionAPI {
  Type: typeof Type;
  readonly credentials: Pick<Credentials, 'read' | 'modify' | 'delete' | 'secret'>;
  readonly inputEpoch: number;
  readonly storage: {
    get<T>(key: string): T | undefined;
    list(prefix: string): { key: string; value: unknown }[];
    set(key: string, value: unknown, sources?: string[]): void;
    delete(key: string): void;
  };
  registerSetup(setup: ExtensionSetup): void;
  agenda(range: { from: string; to: string; timezone: string }, context: Envelope, signal?: AbortSignal): Promise<AgendaContribution>;
  ingest(channel: string, input: unknown, sender: Omit<Envelope['source'], 'channel'>, mode?: 'foreground' | 'ephemeral', epoch?: number): ReturnType<Channels['ingest']>;
  setStatus(key: string, text?: string): void;
  registerTool<T extends TSchema>(tool: ExtensionTool<T>): void;
  replaceTools(tools: ExtensionTool[]): void;
  registerRpc<T extends TSchema>(rpc: ExtensionRpc<T>): void;
  registerChannel(channel: PicoChannel): Promise<void>;
  on<E extends keyof Events>(event: E, handler: Events[E]): void;
}
export const ModuleSchema = object({ sdk: Type.Literal(2), id: Type.String({ pattern: '^[a-z][a-z0-9-]{2,47}$' }),
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' }), description: Type.String({ minLength: 1, maxLength: 4000 }),
  source: Type.String({ minLength: 1, maxLength: 100_000 }) });
export interface ExtensionModule { sdk: 2; id: string; version: string; description: string; source: string }
export const moduleHash = (module: ExtensionModule): string => hash(json({ sdk: module.sdk, id: module.id, version: module.version, description: module.description, source: module.source }));
export const ExtensionResultSchema = object({ content: Type.Array(Type.Union([
  object({ type: Type.Literal('text'), text: Type.String() }),
  object({ type: Type.Literal('image'), data: Type.String(), mimeType: Type.String() })
]), { maxItems: 32 }), details: Type.Optional(Type.Unknown()) });
export const SDK_GUIDE = `Pico extensions are for persistent integrations, channels, RPC and daemon lifecycle hooks. Prefer standard Agent Skills packages (SKILL.md, scripts, references, assets) for calculators, reusable utilities and procedures; create them with skill_build. Extensions execute inside the daemon, with full OS-user permissions, NOT sandboxed.
Export a default function (pico) calling pico.registerTool({name,label,description,parameters,async execute(callId,params,signal,onUpdate,context){return {content:[{type:'text',text:'...'}],details:{}};}}).
Use pico.Type and strict object parameters (additionalProperties:false). Tool input is params, the SECOND execute argument; callId is not input. Implement the requested behavior fully, not a placeholder/stub, and check your own parameter access and returned result before emitting JSON. Never override core or another module's names.
context.services provides authenticated canonical document operations, calendar(request) local appointments/agenda, family(request) explicitly authorized cross-owner reminders/shared checklist items (no private memory or membership administration), generateImage({prompt,size?}) explicitly enabled metered synthetic images, showImage({attachmentId?|documentId?,revision?}) existing-image conversation previews without generation or Telegram, installed skill/resource reads, skills(request) standard package management and runSkill(request) journaled subprocess scripts (not sandboxed), direct createSchedule(definition) without reminder approval, web(request) search/fetch/read/save evidence, bounded read-only research({task,context?}), selected-model completion and immediately activated extension builds. These are data services, not duplicate model tools. Writes retain mode restrictions, revision checks, provenance, operation journals and the shared 32-call budget. Owner/instance identity cannot come from arguments. context.callTool(name,args) calls registered tools with those same guarantees. Always await successful mutation receipts.
Canonical document actions include create/edit/checklist, create_list/append_items/remove_item/delete_list, note_catalog/note_resolve and document import/search/read/items/history. create submission IDs are assigned by the service; import submission is optional and reuses an existing retained attachment import when omitted. Routine note/list/document management needs no command grammar, drafting session or mandatory confirmation in trusted retained owner foreground work.
pico.registerRpc({name,parameters,execute(params,context)}) registers authenticated owner-terminal operations under extensions.MODULE_ID.METHOD. No model-facing RPC dispatcher is supplied. pico.credentials supplies this owner's vault read/modify/delete and supported secret reads (no other owner, environment or ~/.pi fallback). Never include credentials in parameters, output or logs. pico.registerChannel(adapter) attaches a trusted adapter; authorize senders before storage/download, then pico.ingest(channel,input,sender,mode) routes input with fixed owner/instance identity; only the module's channels are accepted. pico.setStatus(key,text) publishes one single-line owner-terminal footer status rendered as 'KEY: text' (for example pico.setStatus('Telegram','connected')); omit text to clear it, and it is removed automatically when the module is disabled. It is display-only, not memory, evidence or authority. pico.on supports instructions, start, shutdown, background, settled and busy. Background receives {signal,modelWorkAllowed,phase}; busy reports pending login/work that must block reload. Cooperate with cancellation and clean up resources.
This is a small Pico API, not Pi coding-agent/UI compatibility. Local modules load only from this instance's extensions/*.ts|js|mjs or extensions/NAME/index.ts|js|mjs. Node 24 supports erasable TypeScript and ordinary imports; no ~/.pi discovery.
Generated single-file JSON is {sdk:2,id,version,description,source}; use only Node builtins and the supplied API. Syntax checks do not execute source, resolve imports, type-check or run tests. Successful builds activate immediately in trusted retained owner foreground work, without confirmation, granting full daemon/OS trust. Validation-only artifacts remain inert until exact-hash terminal approval. Legacy worker approvals/grants remain inert history.
Third-party tool dispatch requires trusted retained foreground work. Shipped feature modules may read in ephemeral/scheduled/untrusted contexts; their core service writes remain denied. These application checks do not confine direct Node access, network, credentials, timers, charges, writes or synchronous blocking. No sandbox or hard termination.`;

interface LoadedModule {
  id: string; hash?: string; path?: string; builtin?: boolean; initializing: boolean;
  tools: ExtensionTool[]; rpcs: ExtensionRpc[]; channels: Set<string>; statusKeys: Set<string>; setup?: ExtensionSetup;
  events: { [E in keyof Events]: Events[E][] };
}
export class Extensions {
  private loaded = new Map<string, LoadedModule>();
  private builtins = new Map<string, (api: ExtensionAPI) => void>();
  private aliases = new Map<string,string>();
  private reserved = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private statusTexts = new Map<string, string>();
  private controller = new AbortController();
  private started = false;
  readonly errors = new Map<string, string>();
  constructor(readonly store: Store, private channels: Pick<Channels, 'attach' | 'detach' | 'ingest' | 'inputEpoch' | 'runtime'>, private credentials: Credentials) {}
  get signal(): AbortSignal { return this.controller.signal; }
  get busy(): boolean { return this.pending.size > 0 || [...this.loaded.values()].some(module => module.events.busy.some(check => check())); }
  get statuses(): Record<string, string> { return Object.fromEntries(this.statusTexts); }
  get status() { return { mode: 'in-process', isolation: 'none', loaded: [...this.loaded.keys()], errors: Object.fromEntries(this.errors), warning: 'Trusted extensions have full daemon/OS-user access; no sandbox.' }; }
  private disabled(): string[] { return JSON.parse(this.store.meta('extensions.disabled') ?? '[]'); }
  private active(module: LoadedModule): boolean {
    if (module.hash) {
      const artifact = this.store.get<{ bundle: string }>('SELECT a.bundle FROM extension_installs i JOIN extension_artifacts a ON a.hash=i.active_hash WHERE i.id=? AND i.enabled=1 AND i.active_hash=?', module.id, module.hash);
      if (!artifact) return false;
      try { return moduleHash(validate<ExtensionModule>(ModuleSchema, JSON.parse(artifact.bundle))) === module.hash; } catch { return false; }
    }
    return !this.disabled().includes(module.id);
  }
  private record(moduleId: string, metadata: { hash?: string; path?: string; builtin?: boolean } = {}): LoadedModule {
    this.controller.signal.throwIfAborted();
    if (!/^[a-z][a-z0-9-]{2,47}$/.test(moduleId)) throw new Error('Invalid extension ID');
    if (this.loaded.has(moduleId)||this.aliases.has(moduleId)) throw new Error('Duplicate extension ID or reserved alias');
    return { id: moduleId, ...metadata, initializing: true, tools: [], rpcs: [], channels: new Set(), statusKeys: new Set(), events: { agenda: [], instructions: [], start: [], shutdown: [], background: [], settled: [], busy: [] } };
  }
  private api(module: LoadedModule): ExtensionAPI {
    const strict = (schema: TSchema) => (schema as { type?: unknown }).type === 'object' && (schema as { additionalProperties?: unknown }).additionalProperties === false;
    const channels = this.channels;
    const current = () => { this.controller.signal.throwIfAborted(); if (!this.active(module) || !module.initializing && this.loaded.get(module.id) !== module) throw new Error('Extension changed or disabled'); };
    const registerTool = (tool: ExtensionTool) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || !tool.label || !tool.description || typeof tool.execute !== 'function' || !strict(tool.parameters) || tool.trustedOnly !== undefined && typeof tool.trustedOnly !== 'boolean') throw new Error('Invalid extension tool; require name, label, description, strict object parameters and execute');
      if (this.reserved.has(tool.name) || this.tools().some(existing => existing.name === tool.name) || module.tools.some(existing => existing.name === tool.name)) throw new Error(`Duplicate/reserved tool name: ${tool.name}`);
      if (tool.history !== undefined) validate(Type.Union([Type.Literal('read'), Type.Literal('effect'), Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,99}$' }), Type.Union([Type.Literal('read'), Type.Literal('effect')]), { additionalProperties: false, maxProperties: 100 })]), tool.history);
      module.tools.push(tool);
    };
    return { Type, get inputEpoch() { return channels.inputEpoch; }, credentials: Object.freeze({ read: this.credentials.read.bind(this.credentials), modify: this.credentials.modify.bind(this.credentials), delete: this.credentials.delete.bind(this.credentials), secret: async (name: string) => { if (!module.setup?.secrets.some(secret => name === `extensions.${module.id}.${secret.name}`)) validate(Type.Union(SECRET_NAMES.map(name => Type.Literal(name))), name); return this.credentials.secret(name); } }),
      storage: {
        get: <T>(key: string) => { current(); const row = this.store.get<{value:string}>('SELECT value FROM extension_storage WHERE extension_id=? AND key=?',module.id,key); return row ? JSON.parse(row.value) as T : undefined; },
        list: prefix => { current(); return this.store.all<{key:string;value:string}>('SELECT key,value FROM extension_storage WHERE extension_id=? AND substr(key,1,length(?))=? ORDER BY key',module.id,prefix,prefix).map(row=>({key:row.key,value:JSON.parse(row.value)})); },
        set: (key,value,sources=[]) => {
          current(); if (!key || key.length>200 || sources.length>1000) throw new Error('Invalid extension storage key/dependencies');
          const data=json(value); if (data===undefined || data.length>1_000_000) throw new Error('Extension storage value exceeds limit');
          this.store.transaction(()=>{
            for (const source of sources) if (this.store.get('SELECT hash FROM deletions WHERE hash=?',hash(`source:${source}`))) throw new Error('Extension storage source was forgotten');
            this.store.run('INSERT INTO extension_storage(extension_id,key,value) VALUES(?,?,?) ON CONFLICT(extension_id,key) DO UPDATE SET value=excluded.value',module.id,key,data);
            this.store.run('DELETE FROM storage_sources WHERE extension_id=? AND key=?',module.id,key);
            for (const source of new Set(sources)) this.store.run('INSERT INTO storage_sources VALUES(?,?,?)',module.id,key,source);
          });
        },
        delete: key => { current(); this.store.transaction(()=>{this.store.run('DELETE FROM extension_storage WHERE extension_id=? AND key=?',module.id,key);this.store.run('DELETE FROM storage_sources WHERE extension_id=? AND key=?',module.id,key);}); }
      },
      registerSetup: setup => { if (module.setup || !strict(setup.parameters) || !setup.title || setup.prepareSecret !== undefined && typeof setup.prepareSecret !== 'function' || setup.secrets.some(secret=>!/^[-a-zA-Z0-9.]{1,64}$/.test(secret.name))) throw new Error('Invalid extension setup'); module.setup=setup; },
      agenda: (range,context,signal) => this.agenda(range,context,signal),
      ingest: (channel, input, sender, mode, epoch) => { current(); if (!module.channels.has(channel)) throw new Error('Channel does not belong to this module'); return this.channels.ingest(channel, input, sender, mode, epoch); },
      setStatus: (key, text) => {
        // Presentation only: malformed keys/values and calls from unloaded modules are ignored rather than failing extension code.
        if (!/^[^\x00-\x1f\x7f]{1,64}$/.test(key) || this.controller.signal.aborted || !module.initializing && this.loaded.get(module.id) !== module) return;
        const value = typeof text === 'string' ? text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) : undefined;
        if (value) { this.statusTexts.set(key, value); module.statusKeys.add(key); }
        else { module.statusKeys.delete(key); if (!this.statusTexts.delete(key)) return; }
        this.channels.runtime.emit({ type: 'extension_status', data: { key, text: value ?? null } });
      },
      registerTool: tool => registerTool(tool as ExtensionTool),
      replaceTools: tools => {
        current(); const previous = module.tools; module.tools = [];
        try { for (const tool of tools) registerTool(tool); }
        catch (error) { module.tools = previous; throw error; }
      }, registerRpc: rpc => {
      if (!/^[a-z][a-z0-9.-]{0,79}$/.test(rpc.name) || !strict(rpc.parameters) || typeof rpc.execute !== 'function' || !module.builtin && !rpc.name.startsWith(`extensions.${module.id}.`)) throw new Error('Invalid extension RPC; require module namespace and strict object parameters');
      if ([...this.loaded.values(), module].some(existing => existing.rpcs.some(entry => entry.name === rpc.name))) throw new Error('Duplicate extension RPC');
      module.rpcs.push(rpc as ExtensionRpc);
    }, registerChannel: async channel => {
      current();
      await this.channels.attach(channel);
      module.channels.add(channel.id);
      module.events.shutdown.push(async () => { module.channels.delete(channel.id); await this.channels.detach(channel.id); });
      this.controller.signal.throwIfAborted();
    }, on: (event, handler) => {
      if (!Object.hasOwn(module.events, event) || typeof handler !== 'function') throw new Error('Unsupported extension event');
      module.events[event].push(handler as never);
    } };
  }
  reserve(names: Iterable<string>): void { this.reserved = new Set(names); }
  registerBuiltin(moduleId: string, factory: (api: ExtensionAPI) => void, aliases: string[]=[]): void {
    if(this.builtins.has(moduleId)||this.aliases.has(moduleId))throw new Error('Duplicate bundled extension ID or reserved alias');
    for(const alias of aliases){if(this.aliases.has(alias)||this.builtins.has(alias))throw new Error('Duplicate extension alias');this.aliases.set(alias,moduleId);}
    if(aliases.some(alias=>this.disabled().includes(alias)))this.store.setMeta('extensions.disabled',json([...new Set(this.disabled().map(value=>aliases.includes(value)?moduleId:value))]));
    this.builtins.set(moduleId, factory);
    if (this.disabled().includes(moduleId)) return;
    const module = this.record(moduleId, { builtin: true });
    factory(this.api(module)); module.initializing = false; this.loaded.set(moduleId, module);
  }
  isBuiltinTool(name: string): boolean { return [...this.loaded.values()].some(module => module.builtin && this.active(module) && module.tools.some(tool => tool.name === name)); }
  toolHistoryPolicy(name:string):ToolHistoryPolicy|undefined{return [...this.loaded.values()].filter(module=>module.builtin&&this.active(module)).flatMap(module=>module.tools).find(tool=>tool.name===name)?.history;}
  tools(): ExtensionTool[] { return [...this.loaded.values()].filter(module => this.active(module)).flatMap(module => module.tools); }
  toolGroups(names: ReadonlySet<string>): Record<string, string[]> {
    return Object.fromEntries([...this.loaded.values()].filter(module => this.active(module)).flatMap(module => {
      const tools = module.tools.filter(tool => names.has(tool.name)).map(tool => tool.name);
      return tools.length ? [[module.id, tools]] : [];
    }));
  }
  list(): unknown[] { return [...this.store.all<{id:string}>('SELECT i.*,a.version,a.report,a.bundle FROM extension_installs i LEFT JOIN extension_artifacts a ON a.hash=i.active_hash').map(record=>({...record,setup:!!this.loaded.get(record.id)?.setup})),
    ...[...this.builtins.keys()].map(moduleId => ({ id: moduleId, builtin: true, enabled: !this.disabled().includes(moduleId), tools: this.loaded.get(moduleId)?.tools.map(tool => tool.name) ?? [], setup: !!this.loaded.get(moduleId)?.setup })),
    ...[...this.loaded.values()].filter(module => !module.hash && !module.builtin).map(module => ({ id: module.id, path: module.path, enabled: this.active(module), tools: module.tools.map(tool => tool.name), setup: !!module.setup }))]; }
  setup(moduleId: string): unknown {
    const module=this.loaded.get(moduleId); if (!module?.setup || !this.active(module)) throw new Error('Extension setup unavailable');
    const {title,description,parameters,secrets}=module.setup;
    return {id:moduleId,title,description,parameters,secrets,settings:module.setup.read()};
  }
  async configure(moduleId: string, settings: unknown): Promise<void> {
    const module=this.loaded.get(moduleId); if (!module?.setup || !this.active(module)) throw new Error('Extension setup unavailable');
    await this.track(Promise.resolve(module.setup.save(validate(module.setup.parameters,settings))));
  }
  async setupSecret(moduleId: string, name: string, value: string): Promise<void> {
    const module=this.loaded.get(moduleId); if (!module?.setup || !this.active(module) || !module.setup.secrets.some(secret=>secret.name===name) || !value || value.length>16_000) throw new Error('Invalid extension secret');
    const prepared = module.setup.prepareSecret ? module.setup.prepareSecret(name, value) : value;
    await this.track(this.credentials.setSecret(`extensions.${moduleId}.${name}`, prepared));
  }
  async agenda(range: {from:string;to:string;timezone:string},context: Envelope,signal?: AbortSignal): Promise<AgendaContribution> {
    if (context.ownerId!==this.store.config.ownerId || context.instanceId!==this.store.config.instanceId) throw new Error('Agenda ownership mismatch');
    const result:AgendaContribution={items:[],truncated:false,warnings:[]};
    for (const module of this.loaded.values()) if (this.active(module)) for (const handler of module.events.agenda) {
      signal?.throwIfAborted();
      try {
        if(!module.builtin&&(context.mode!=='foreground'||!context.source.trustedOwner))throw new Error('Native agenda unavailable in restricted execution');
        const contribution=validate<AgendaContribution>(AgendaContributionSchema,await handler(range,context,signal));
        for(const item of contribution.items){const start=instant(item.at);if(item.end&&instant(item.end)<=start)throw new Error('Invalid external event interval');}
        result.items.push(...contribution.items);result.truncated ||= contribution.truncated;result.warnings.push(...contribution.warnings);
      }
      catch {signal?.throwIfAborted();result.truncated=true;result.warnings.push(`${module.id}: external agenda unavailable; local results are incomplete`);}
    }
    return result;
  }
  discover(): unknown { return { sdk: SDK_GUIDE, schemas: { module: ModuleSchema }, installed: this.list(), execution: this.status,
    tools: this.tools().map(({ name, label, description, parameters }) => ({ name, label, description, parameters })) }; }
  async load(reserved: Iterable<string>): Promise<void> {
    this.reserve(reserved);
    // An interrupted factory may already have effects; never replay its initialization automatically.
    this.store.transaction(() => {
      this.store.run("UPDATE extension_installs SET enabled=0 WHERE active_hash IN (SELECT artifact_hash FROM builds WHERE status='activating')");
      this.store.run("UPDATE builds SET status='interrupted',diagnostic='Initialization interrupted; effects uncertain. Not automatically replayed.' WHERE status='activating'");
    });
    const directory = join(this.store.root, 'extensions');
    if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name) ? join(directory, entry.name) : entry.isDirectory() ? ['index.ts', 'index.js', 'index.mjs'].map(file => join(directory, entry.name, file)).find(existsSync) : undefined;
      if (!path) continue;
      const moduleId = entry.name.replace(/\.(ts|js|mjs)$/, '');
      try { await this.register(moduleId, pathToFileURL(path).href + `?pico=${id()}`, { path }); }
      catch (error) { this.errors.set(moduleId, error instanceof Error ? error.message : 'Extension load failed'); }
    }
    for (const install of this.store.all<{ id: string; active_hash: string }>('SELECT id,active_hash FROM extension_installs WHERE enabled=1')) if (this.loaded.get(install.id)?.hash !== install.active_hash || !this.active(this.loaded.get(install.id)!)) await this.loadManaged(install.id, install.active_hash);
    this.started = true;
    for (const module of this.loaded.values()) await this.track(this.events(module, 'start'));
  }
  private async events<E extends 'start' | 'shutdown'>(module: LoadedModule, event: E): Promise<void> {
    if (event === 'start') { for (const handler of module.events.start) await handler(); return; }
    const results = await Promise.allSettled(module.events.shutdown.map(handler => Promise.resolve().then(handler)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, `Extension ${event} failed`);
  }
  private async track<T>(work: Promise<T>): Promise<T> { this.pending.add(work); try { return await work; } finally { this.pending.delete(work); } }
  private async register(moduleId: string, url: string, metadata: { hash?: string; path?: string }): Promise<void> {
    await this.track((async () => {
      if (this.builtins.has(moduleId)) throw new Error('ID belongs to a bundled extension');
      if (!metadata.hash && this.disabled().includes(moduleId)) return;
      const module = this.record(moduleId, metadata);
      try {
        const imported = await import(/* @vite-ignore */ url);
        if (typeof imported.default !== 'function') throw new Error('Extension must export a default factory');
        await imported.default(this.api(module));
        this.controller.signal.throwIfAborted();
        if (this.started) await this.events(module, 'start');
        module.initializing = false; this.loaded.set(moduleId, module); this.errors.delete(moduleId);
      } catch (error) { module.initializing = false; await this.events(module, 'shutdown'); throw error; }
    })());
  }
  private async loadManaged(moduleId: string, artifactHash: string): Promise<void> {
    try {
      const row = this.store.get<{ bundle: string }>('SELECT bundle FROM extension_artifacts WHERE hash=?', artifactHash);
      const module = validate<ExtensionModule>(ModuleSchema, JSON.parse(row?.bundle ?? '{}'));
      if (module.id !== moduleId || moduleHash(module) !== artifactHash) throw new Error('Artifact integrity failure');
      const code = stripTypeScriptTypes(module.source);
      await this.register(moduleId, `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${this.store.config.instanceId}:${id()}`, { hash: artifactHash });
    } catch (error) { this.errors.set(moduleId, error instanceof Error ? error.message : 'Extension load failed'); }
  }
  private checkModule(input: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const module = validate<ExtensionModule>(ModuleSchema, input), code = stripTypeScriptTypes(module.source);
    if (this.builtins.has(module.id)) throw new Error('ID belongs to a bundled extension');
    try { execFileSync(process.execPath, ['--check', '--input-type=module'], { input: code, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw new Error('Extension syntax check failed'); }
    signal?.throwIfAborted();
    return { hash: moduleHash(module), module, report: { syntaxChecked: true, executed: false, testsRun: false, executionMode: 'in-process', isolation: 'none' } };
  }
  async validateModule(input: unknown, signal?: AbortSignal) {
    const { hash: artifactHash, module, report } = this.checkModule(input, signal), approvalId = id();
    this.store.transaction(() => {
      this.store.run('INSERT OR IGNORE INTO extension_artifacts VALUES(?,?,?,?,?,?)', artifactHash, module.id, module.version, json(module), json(report), Date.now());
      this.store.run('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)', approvalId, 'activate-native', artifactHash, artifactHash, Date.now() + 86_400_000, 'pending', Date.now());
    });
    return { hash: artifactHash, module, report, approvalId };
  }
  beginBuild(specification: string, context: Envelope) {
    const buildId = id(); this.store.run('INSERT INTO builds(id,specification,status,created_at) VALUES(?,?,?,?)', buildId, specification, 'generating', Date.now());
    this.store.run('INSERT INTO build_derivations VALUES(?,?)', buildId, context.runId);
    return { buildId, installed: [...new Set([...this.builtins.keys(), ...this.loaded.keys(), ...this.store.all<{ id: string }>('SELECT id FROM extension_installs').map(row => row.id)])].map(id => ({ id })) };
  }
  updateBuild(buildId: string, status: 'repairing' | 'failed', diagnostic: string, context: Envelope): void {
    this.assertBuild(buildId, context); this.store.run('UPDATE builds SET status=?,diagnostic=? WHERE id=?', status, diagnostic, buildId);
  }
  private assertBuild(buildId: string, context: Envelope): void {
    if (!this.store.get('SELECT build_id FROM build_derivations WHERE build_id=? AND run_id=?', buildId, context.runId)) throw new Error('Build does not belong to this execution');
  }
  async stageBuild(buildId: string, module: ExtensionModule, context: Envelope, signal?: AbortSignal) {
    if (context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId || !context.source.trustedOwner || context.mode !== 'foreground') throw new Error('Automatic activation requires trusted retained owner work');
    this.assertBuild(buildId, context);
    const result = this.checkModule(module, signal);
    this.store.transaction(() => {
      this.store.run('INSERT OR IGNORE INTO extension_artifacts VALUES(?,?,?,?,?,?)', result.hash, result.module.id, result.module.version, json(result.module), json(result.report), Date.now());
      this.store.run('INSERT OR IGNORE INTO artifact_derivations VALUES(?,?)', result.hash, context.runId);
      this.store.run("UPDATE builds SET status='activating',artifact_hash=?,diagnostic=NULL WHERE id=?", result.hash, buildId);
      this.install(result.module, result.hash, context, 'delegated');
    });
    let error: string | undefined;
    try {
      await this.unload(module.id);
      signal?.throwIfAborted();
      await this.loadManaged(module.id, result.hash);
      signal?.throwIfAborted();
      const loaded = this.loaded.get(module.id);
      if (!loaded || loaded.hash !== result.hash || !this.active(loaded)) throw new Error(this.errors.get(module.id) ?? 'Extension changed or disabled during activation');
    } catch (cause) {
      error = cause instanceof Error && cause.message ? cause.message : 'Extension activation failed; effects may already have occurred';
      this.store.run('UPDATE extension_installs SET enabled=0 WHERE id=? AND active_hash=?', module.id, result.hash);
      try { await this.unload(module.id); } catch { error += '; extension cleanup failed'; }
    }
    this.store.run('UPDATE builds SET status=?,diagnostic=? WHERE id=?', error ? 'failed' : 'active', error ?? null, buildId);
    return { activated: !error, tools: error ? [] : this.loaded.get(module.id)!.tools.map(tool => tool.name), ...(error ? { error } : {}), ...result };
  }
  private install(module: ExtensionModule, artifactHash: string, context: Envelope, decision: 'approved' | 'delegated'): void {
    if (this.builtins.has(module.id) || this.loaded.get(module.id)?.path) throw new Error('ID belongs to a bundled or local extension');
    this.store.run('INSERT INTO extension_installs(id,active_hash,previous_hash,enabled) VALUES(?,?,NULL,1) ON CONFLICT(id) DO UPDATE SET previous_hash=extension_installs.active_hash,active_hash=excluded.active_hash,enabled=1,failures=0', module.id, artifactHash);
    this.store.audit('extension.activate-native', decision, context.runId);
  }
  review(approvalId: string): unknown {
    const approval = this.store.get<{ artifact_hash: string }>('SELECT * FROM approvals WHERE id=?', approvalId);
    if (!approval) throw new Error('Approval not found');
    const artifact = this.store.get<{ bundle: string; extension_id: string; report: string }>('SELECT * FROM extension_artifacts WHERE hash=?', approval.artifact_hash);
    if (!artifact) throw new Error('Artifact not found');
    const current = this.store.get<{ bundle: string }>('SELECT a.bundle FROM extension_installs i JOIN extension_artifacts a ON a.hash=i.active_hash WHERE i.id=?', artifact.extension_id);
    return { approval, artifact: JSON.parse(artifact.bundle), report: JSON.parse(artifact.report), previous: current ? JSON.parse(current.bundle) : null, permissions: 'Full daemon/OS-user access, including files, credentials, network and processes. Not sandboxed.' };
  }
  async approve(approvalId: string, artifactHash: string, decision: boolean, context: Envelope): Promise<void> {
    if (context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId || !context.source.trustedOwner || context.source.channel !== 'terminal' || context.mode !== 'foreground') throw new Error('Dedicated authenticated owner-terminal approval required');
    let moduleId: string | undefined;
    this.store.transaction(() => {
      const approval = this.store.get<{ operation: string; artifact_hash: string; canonical_hash: string; expires_at: number; status: string }>('SELECT * FROM approvals WHERE id=?', approvalId);
      const artifact = this.store.get<{ bundle: string }>('SELECT bundle FROM extension_artifacts WHERE hash=?', artifactHash);
      if (!approval || approval.operation !== 'activate-native' || approval.status !== 'pending' || approval.expires_at <= Date.now() || approval.artifact_hash !== artifactHash || !artifact) throw new Error('Approval expired, consumed, legacy, unknown, or hash mismatch');
      const module = validate<ExtensionModule>(ModuleSchema, JSON.parse(artifact.bundle));
      if (moduleHash(module) !== artifactHash || artifactHash !== approval.canonical_hash) throw new Error('Artifact changed after approval');
      if (this.builtins.has(module.id) || this.loaded.get(module.id)?.path) throw new Error('ID belongs to a bundled or local extension');
      this.store.run('UPDATE approvals SET status=? WHERE id=?', decision ? 'consumed' : 'rejected', approvalId);
      if (!decision) return;
      moduleId = module.id;
      this.install(module, artifactHash, context, 'approved');
    });
    if (moduleId) { await this.unload(moduleId); await this.loadManaged(moduleId, artifactHash); }
  }
  private async unload(moduleId: string): Promise<void> {
    const module = this.loaded.get(moduleId); this.loaded.delete(moduleId);
    if (module) {
      for (const key of module.statusKeys) if (this.statusTexts.delete(key)) this.channels.runtime.emit({ type: 'extension_status', data: { key, text: null } });
      module.statusKeys.clear();
      await this.track(this.events(module, 'shutdown'));
    }
  }
  async disable(moduleId: string): Promise<void> {
    moduleId=this.aliases.get(moduleId)??moduleId;
    if (!this.builtins.has(moduleId) && !this.loaded.has(moduleId) && !this.store.get('SELECT id FROM extension_installs WHERE id=?', moduleId)) throw new Error('Extension missing');
    this.store.run('UPDATE extension_installs SET enabled=0 WHERE id=?', moduleId);
    if (this.builtins.has(moduleId) || this.loaded.get(moduleId)?.path) this.store.setMeta('extensions.disabled', json([...new Set([...this.disabled(), moduleId])]));
    await this.unload(moduleId);
  }
  async enable(moduleId: string): Promise<void> {
    moduleId=this.aliases.get(moduleId)??moduleId;
    const factory = this.builtins.get(moduleId);
    if (!factory) throw new Error('Only bundled extensions can be enabled here; managed code requires approval or rollback');
    if (this.loaded.has(moduleId)) return;
    this.store.setMeta('extensions.disabled', json(this.disabled().filter(value => value !== moduleId)));
    const module = this.record(moduleId, { builtin: true });
    try { factory(this.api(module)); if (this.started) await this.track(this.events(module, 'start')); module.initializing = false; this.loaded.set(moduleId, module); }
    catch (error) { module.initializing = false; this.store.setMeta('extensions.disabled', json([...new Set([...this.disabled(), moduleId])])); await this.events(module, 'shutdown'); throw error; }
  }
  async rollback(moduleId: string): Promise<void> {
    const previous = this.store.get<{ previous_hash: string; bundle: string }>('SELECT i.previous_hash,a.bundle FROM extension_installs i JOIN extension_artifacts a ON a.hash=i.previous_hash WHERE i.id=?', moduleId);
    if (!previous) throw new Error('No previous installed version');
    const module = validate<ExtensionModule>(ModuleSchema, JSON.parse(previous.bundle));
    if (module.id !== moduleId || moduleHash(module) !== previous.previous_hash || this.builtins.has(moduleId)) throw new Error('Artifact integrity failure');
    this.store.run('UPDATE extension_installs SET active_hash=previous_hash,previous_hash=active_hash,enabled=1,failures=0 WHERE id=?', moduleId);
    await this.unload(moduleId); await this.loadManaged(moduleId, previous.previous_hash);
  }
  private context(context: Envelope, services: ExtensionServices, callTool: ExtensionContext['callTool'], writesAllowed: boolean): ExtensionContext {
    return Object.freeze({ ...context, source: Object.freeze({ ...context.source }), services, callTool, writesAllowed: writesAllowed && context.mode==='foreground' && context.source.trustedOwner });
  }
  async invoke(name: string, input: unknown, context: Envelope, callId: string, callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<AgentToolResult>, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback, services?: (signal: AbortSignal, assertCurrent: () => void) => ExtensionServices, writesAllowed=false): Promise<AgentToolResult> {
    if (context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId) throw new Error('Ownership mismatch');
    const module = [...this.loaded.values()].find(module => this.active(module) && module.tools.some(tool => tool.name === name));
    if ((!module?.builtin || module.tools.find(tool => tool.name === name)?.trustedOnly) && (context.mode !== 'foreground' || !context.source.trustedOwner)) throw new Error('Native extensions require trusted retained foreground work');
    if (!module) throw new Error('Extension tool disabled, missing, or legacy; use a registered tool name');
    const tool = module.tools.find(tool => tool.name === name)!;
    if (tool.trustedOnly && !writesAllowed) throw new Error('Trusted-only extension tool denied in restricted execution');
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    combined.throwIfAborted(); const args = validate(tool.parameters, input);
    let open = true;
    const current = () => { combined.throwIfAborted(); if (!open || !this.active(module) || this.loaded.get(module.id) !== module) throw new Error('Extension execution ended, changed or disabled'); };
    try {
      return await this.track(Promise.resolve().then(async () => {
        current();
        const bound = this.context(context, services?.(combined, current)!, async (name, args) => { current(); return callTool(name, args, combined); }, writesAllowed);
        return validate<AgentToolResult>(ExtensionResultSchema, await tool.execute(callId, args, combined, onUpdate, bound));
      }));
    } finally { open = false; }
  }
  instructions(context: Envelope, tools?: ReadonlySet<string>, previous?: ReadonlySet<string>): string {
    const bound = Object.freeze({ ...context, source: Object.freeze({ ...context.source }) });
    // Channel intake/reply guidance applies even when that module's send tools are deferred.
    const shared = (module: LoadedModule) => !module.tools.length || module.channels.has(context.source.channel);
    return [...this.loaded.values()].filter(module => this.active(module) && (!tools || shared(module) || module.tools.some(tool => tools.has(tool.name))) && (!previous || !shared(module) && !module.tools.some(tool => previous.has(tool.name)))).flatMap(module => module.events.instructions.map(handler => handler(bound))).join('\n');
  }
  hasRpc(name: string): boolean { return [...this.loaded.values()].some(module => this.active(module) && module.rpcs.some(rpc => rpc.name === name)); }
  async invokeRpc(name: string, args: unknown, context: ExtensionContext): Promise<unknown> {
    if (context.mode !== 'foreground' || !context.source.trustedOwner || context.source.channel !== 'terminal' || context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId) throw new Error('Authenticated owner-terminal RPC required');
    const rpc = [...this.loaded.values()].filter(module => this.active(module)).flatMap(module => module.rpcs).find(rpc => rpc.name === name);
    if (!rpc) throw new Error('Extension operation unavailable; enable its module');
    return this.track(rpc.execute(validate(rpc.parameters, args), context));
  }
  async background(context: BackgroundContext): Promise<void> {
    for (const module of this.loaded.values()) if (this.active(module)) for (const handler of module.events.background) {
      context.signal.throwIfAborted();
      try{await this.track(Promise.resolve(handler(context)));}
      catch(error){throw new Error(`Background extension ${module.id}: ${error instanceof Error?error.message:'failed'}`,{cause:error});}
    }
  }
  async settled(runId: string): Promise<void> {
    for (const module of this.loaded.values()) if (this.active(module)) for (const handler of module.events.settled) await this.track(Promise.resolve(handler(runId)));
  }
  async prune(): Promise<void> { for (const module of this.loaded.values()) if (module.hash && !this.active(module)) await this.unload(module.id); }
  async close(): Promise<void> {
    this.controller.abort(new Error('Daemon stopping; accepted effects are not undone'));
    await Promise.allSettled([...this.pending]);
    const results = await Promise.allSettled([...this.loaded.keys()].map(moduleId => this.unload(moduleId)));
    if (results.some(result => result.status === 'rejected')) throw new Error('Extension shutdown failed');
  }
}
