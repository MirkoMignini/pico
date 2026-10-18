#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { initialize, loadConfig } from './config.js';
import { Client } from './client.js';
import { serve } from './daemon.js';
import { chat, safeTerminal } from './tui.js';
import type { AuthPrompt, AuthType } from '@earendil-works/pi-ai';
import type { AuthProvider } from './contracts.js';
import { authEventText, loginProvider } from './auth-client.js';
import { restore } from './backup.js';
import { hash, json } from './store.js';
import { validate } from './contracts.js';
import { McpCredentialsSchema, mcpSettings } from './mcp-contracts.js';
import { browserSettings, prepareBrowserDirectories } from './mcp-browser.js';
import { doctor, formatDoctor } from './doctor.js';
import { manageService, type ServiceAction } from './service.js';
import { NODE_VERSION, VERSION } from './version.js';

async function stdinText(limit:number):Promise<string>{const chunks:Buffer[]=[];let bytes=0;for await(const data of process.stdin){bytes+=data.length;if(bytes>limit)throw new Error('Input exceeds supported size');chunks.push(data);}return Buffer.concat(chunks).toString();}
async function secretInput(prompt: string, signal?: AbortSignal, limit = 4000): Promise<string> {
  signal?.throwIfAborted();
  if(!process.stdin.isTTY)return(await stdinText(limit)).trim();
  process.stderr.write(prompt);
  const input = process.stdin; input.setRawMode(true); input.resume();
  return new Promise((resolve,reject) => {
    let value = '';
    const onData = (data: Buffer) => {
      for (const char of data.toString()) {
        if (char === '\u0003') { done(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { done(); resolve(value.trim()); return; }
        if (char === '\u007f') value = value.slice(0,-1); else if (char >= ' ') value += char;
        if(value.length>limit){done();reject(new Error('Secret input exceeds supported limit'));return;}
      }
    };
    const abort = () => { done(); reject(new Error('Login cancelled')); };
    const done = () => { signal?.removeEventListener('abort', abort); input.off('data',onData); input.setRawMode(false); input.pause(); process.stderr.write('\n'); };
    input.on('data',onData); signal?.addEventListener('abort', abort, { once: true });
  });
}
async function authPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === 'secret' || prompt.type === 'manual_code') return secretInput(`${safeTerminal(prompt.message)} (hidden): `, prompt.signal, 8192);
  if (prompt.type === 'select') for (const [index, option] of prompt.options.entries()) process.stderr.write(`${index + 1}. ${safeTerminal(option.label)}${option.description ? ` — ${safeTerminal(option.description)}` : ''}\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const value = (await terminal.question(`${safeTerminal(prompt.message)}${prompt.type === 'select' ? ' [1]' : ''}: `, { signal: prompt.signal })).trim();
    if (prompt.type !== 'select') return value;
    const selected = prompt.options[Number(value || '1') - 1];
    if (!selected) throw new Error('Invalid selection');
    return selected.id;
  } finally { terminal.close(); }
}
async function login(client: Client, providerId?: string, type?: AuthType, account = 'default'): Promise<unknown> {
  if (!process.stdin.isTTY) throw new Error('Use login in a terminal or the Pico TUI; API keys can still use auth key with private stdin');
  const providers = await client.rpc<AuthProvider[]>('auth.providers');
  if (!providerId) {
    type ??= await authPrompt({ type: 'select', message: 'Select authentication method', options: [{ id: 'oauth', label: 'Sign in with an account' }, { id: 'api_key', label: 'Sign in with an API key' }] }) as AuthType;
    providerId = await authPrompt({ type: 'select', message: 'Select provider', options: providers.filter(provider => provider.methods.some(method => method.type === type)).map(provider => ({ id: provider.id, label: provider.name })) });
  }
  const provider = providers.find(item => item.id === providerId);
  if (!provider || type && !provider.methods.some(method => method.type === type)) throw new Error('Unsupported provider authentication method');
  type ??= provider.methods.length === 1 ? provider.methods[0]!.type : await authPrompt({ type: 'select', message: 'Select authentication method', options: provider.methods.map(method => ({ id: method.type, label: method.label })) }) as AuthType;
  const controller = new AbortController(), cancel = () => controller.abort(); process.once('SIGINT', cancel);
  try {
    const result = await loginProvider(client, providerId, type, { signal: controller.signal, prompt: authPrompt, notify: event => process.stderr.write(safeTerminal(authEventText(event)) + '\n') }, account);
    return { state: result.state, provider: providerId, credentials: 'Private Pico store; select a model explicitly' };
  } finally { process.off('SIGINT', cancel); }
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: { instance: { type:'string',short:'i' }, name:{type:'string'}, 'confirm-original-stopped':{type:'boolean'}, 'allow-reminders':{type:'boolean'}, help:{type:'boolean',short:'h'}, version:{type:'boolean',short:'v'}, json:{type:'boolean'}, offline:{type:'boolean'}, 'confirm-stop':{type:'boolean'} }, allowPositionals:true, strict:true });
  const root = resolve(values.instance ?? join(homedir(),'.local','share','pico'));
  const [command = 'chat',...args] = positionals;
  const print = (value:unknown) => process.stdout.write(JSON.stringify(value,null,2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))+'\n');
  if (values.version) { process.stdout.write(`Pico ${VERSION}\n`); return; }
  if (values.help || command === 'help') {
    process.stdout.write(`Pico ${VERSION} — private personal assistant\n\nUse: pico [--instance PRIVATE_PATH] COMMAND\n\ninit --name NAME         Initialize a NEW private owner once\nchat                     Open TUI; /setup configures services with masked dialogs\nserve                    Run the daemon in the foreground\ndoctor [--offline] [--json]  Redacted checks; never starts a daemon or calls providers\nreadiness                Current setup evidence; requires an already running daemon\nstatus                   Private detailed status; never starts a daemon\nservice install|status|start  Explicit per-user launchd/systemd management\nservice stop|restart|uninstall --confirm-stop  Idle only; close TUI clients first\nbackup | export          Private owner data operations\nrestore BACKUP --confirm-original-stopped  Offline recovery\nlogin | logout | auth | knowledge | skills | extensions | family | mcp | rpc\n\nNode ${NODE_VERSION} is required. Installation/upgrade/recovery: docs/INSTALLATION.md.\nStored credentials do not prove live access. Model/connector tests are explicit and may charge.\n`); return;
  }
  if (command === 'doctor') {
    if (args.length) throw new Error('Use doctor [--offline] [--json] without positional arguments');
    const report = await doctor(root, !!values.offline); values.json ? print(report) : process.stdout.write(formatDoctor(report));
    if (!report.ok) process.exitCode = 1; return;
  }
  if (process.versions.node !== NODE_VERSION) throw new Error(`Use the pinned Node.js ${NODE_VERSION} runtime (see .node-version)`);
  if (command === 'service') {
    if (args.length !== 1 || !['install','status','start','stop','restart','uninstall'].includes(args[0]!)) throw new Error('Use service install|status|start|stop|restart|uninstall; stopping/restarting requires --confirm-stop');
    print(await manageService(root, args[0] as ServiceAction, { confirmStop: !!values['confirm-stop'] })); return;
  }
  if (command === 'status' || command === 'readiness') {
    if (args.length) throw new Error('Use status or readiness without arguments');
    print(await new Client(root).rpc(command)); return;
  }
  if (command === 'init') { print({initialized:true,path:root,...initialize(root,values.name ?? 'Pico')}); return; }
  if (command === 'restore') { if (!args[0]) throw new Error('Use restore BACKUP --confirm-original-stopped with the original stopped'); await restore(root,args[0],values['confirm-original-stopped'] ?? false); print({restored:true,credentials:'Current secret store preserved; excluded from backups'}); return; }
  if (command === 'serve') {
    const daemon = await serve(root);
    process.stdout.write(json({level:'info',event:'daemon_ready',instanceId:daemon.runtime.store.config.instanceId,ownerId:daemon.runtime.store.config.ownerId})+'\n');
    void daemon.done.then(() => process.exit(0), () => { process.stderr.write('Daemon shutdown failed; inspect private state before restarting.\n'); process.exit(1); });
    const close = () => { void daemon.close().catch(() => {}); };
    process.once('SIGINT',close); process.once('SIGTERM',close); return;
  }
  if(command==='auth'&&['key','secret','chatgpt','codex'].includes(args[0]!)&&args.length>2)throw new Error('Never pass a secret as a command argument. Use the hidden terminal prompt or private piped stdin.');
  if (command === 'mcp' && args[0] === 'secret' && args.length !== 2) throw new Error('Use mcp secret SERVER; never pass credentials as arguments. Use the hidden prompt or private stdin.');
  if (['login','logout'].includes(command) && (args.length > 1 || args[0] && !/^[a-z0-9-]{1,80}$/.test(args[0]))) throw new Error('Use login or logout with only a provider ID; never inline credentials');
  const client = new Client(root); await client.ensureDaemon();
  if (command === 'family') {
    const [action = 'members', value] = args;
    if (action === 'identity') {
      if (!value) throw new Error('Use family identity OUTPUT.json; public cards contain no private key');
      const card = await client.rpc<{ publicKey: string; instanceId: string; ownerId: string }>('family.identity');
      await import('node:fs/promises').then(fs => fs.writeFile(resolve(value), json(card), { mode: 0o600, flag: 'wx' }));
      print({ saved: true, publicIdentity: true, instanceId: card.instanceId, ownerId: card.ownerId, fingerprint: hash(card.publicKey) });
    } else if (action === 'add') {
      if (!value || !values.name) throw new Error('Use family add CARD.json --name ALIAS [--allow-reminders]; verify the card with its owner first');
      if (!(await stat(resolve(value))).isFile() || (await stat(resolve(value))).size > 16_000) throw new Error('Invalid family identity file');
      print(await client.rpc('family.add', { card: JSON.parse(await readFile(resolve(value), 'utf8')), alias: values.name, allowReminders: values['allow-reminders'] ?? false }));
    } else if (action === 'revoke') {
      if (!value) throw new Error('Use family revoke MEMBER_ID_OR_ALIAS');
      print(await client.rpc('family.revoke', { member: value }));
    } else if (action === 'members' || action === 'receipts') print(await client.rpc(`family.${action}`));
    else throw new Error('Family: identity OUTPUT.json, add CARD.json --name ALIAS [--allow-reminders], members, receipts, revoke MEMBER');
    return;
  }
  if (command === 'mcp') {
    const [action = 'status', server, value, ...extra] = args;
    if (extra.length || value && !['call', 'read', 'prompt', 'tasks'].includes(action)) throw new Error('Unexpected MCP arguments; credentials belong only in the masked secret prompt');
    const invoke = (name: string, input: Record<string, unknown> = {}) => client.rpc(`extensions.mcp.${name}`, input);
    if (action === 'browser') {
      if (!server) throw new Error('Use mcp browser /absolute/path/to/already-installed/@playwright/mcp/cli.js; no package or browser is installed automatically');
      const current = await client.rpc<{ settings: unknown }>('extensions.setup', { id: 'mcp' });
      const settings = browserSettings(root, current.settings, server);
      prepareBrowserDirectories(root);
      await client.rpc('extensions.configure', { id: 'mcp', settings });
      print({ saved: true, next: '/mcp connect browser; /mcp catalog browser. All browser tools need exact approval. Login/CAPTCHA: /mcp pause browser, interact manually, /mcp resume browser.' });
    } else if (action === 'configure') {
      if (!server) throw new Error('Use mcp configure SETTINGS.json|- (non-secret settings only)');
      const raw = server === '-' ? await stdinText(1_000_000) : await (async () => { const path = resolve(server), info = await stat(path); if (!info.isFile() || info.size > 1_000_000) throw new Error('MCP settings file exceeds limits'); return readFile(path, 'utf8'); })();
      let settings: unknown; try { settings = JSON.parse(raw); } catch { throw new Error('Invalid MCP settings JSON'); }
      print(await client.rpc('extensions.configure', { id: 'mcp', settings: mcpSettings(settings) }));
    } else if (action === 'secret') {
      let secret = await secretInput(`${server}: MCP credential JSON (hidden): `, undefined, 16_000);
      try {
        try { validate(McpCredentialsSchema, JSON.parse(secret)); } catch { throw new Error('Invalid MCP credential JSON; expected env, headers and/or oauthClientSecret'); }
        print(await client.rpc('extensions.secret', { id: 'mcp', name: server, value: secret }));
      } finally { secret = ''; }
    } else if (action === 'approve' || action === 'respond') {
      if (!server || !process.stdin.isTTY) throw new Error(`Use mcp ${action} ID in an owner terminal; noninteractive approval is deliberately unavailable`);
      const review = await invoke(action === 'approve' ? 'actions.review' : 'requests.read', { id: server }) as { id: string; digest: string; status?: string; expiresAt: number; kind?: string; request?: { mode?: string } };
      if (review.expiresAt <= Date.now() || action === 'approve' && review.status !== 'pending') throw new Error('MCP approval/request expired, consumed or uncertain');
      print(review);
      const selected = await authPrompt({ type: 'select', message: action === 'respond' && review.kind === 'sampling' ? 'Approve this exact external sampling request? The selected model may incur charges.' : 'Approve this exact external request once?', options: [{ id: 'no', label: 'Reject (default)' }, { id: 'yes', label: 'Approve exact request' }] });
      if (action === 'approve') print(await invoke('actions.approve', { id: review.id, digest: review.digest, decision: selected === 'yes' }));
      else {
        let content: Record<string, unknown> | undefined;
        if (selected === 'yes' && review.kind === 'elicitation' && review.request?.mode !== 'url') { let text = await secretInput('Form response JSON (hidden; never enter credentials): ', undefined, 128_000); try { content = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('Invalid MCP form JSON'); } finally { text = ''; } }
        print(await invoke('requests.respond', { id: review.id, digest: review.digest, action: selected === 'yes' ? 'accept' : 'decline', ...(content ? { content } : {}) }));
      }
    } else if (['connect', 'disconnect', 'auth', 'cancel', 'logout', 'ping', 'pause', 'resume'].includes(action)) {
      if (!server) throw new Error(`Use mcp ${action} SERVER`);
      print(await invoke(action === 'cancel' ? 'auth.cancel' : action, { server }));
    } else if (action === 'status' || action === 'requests' || action === 'actions') { if (server) throw new Error(`Use mcp ${action} without arguments`); print(await invoke(action === 'actions' ? 'actions.list' : action)); }
    else if (action === 'catalog') print(await invoke('catalog', server ? { server } : {}));
    else if (action === 'import' || action === 'artifact') {
      if (!server || value) throw new Error('Use mcp import|artifact SERVER with sourceId and contentIndex or file in JSON stdin');
      let input: unknown; try { input = JSON.parse(await stdinText(16_000)); } catch { throw new Error('Supply MCP artifact/import JSON through stdin'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MCP artifact/import requires a JSON object');
      print(await invoke(action, { ...input, server }));
    } else if (action === 'call' || action === 'prompt') {
      if (!server || !value) throw new Error(`Use mcp ${action} SERVER NAME; supply optional JSON arguments through stdin`);
      let input: unknown; try { input = JSON.parse(process.stdin.isTTY ? '{}' : (await stdinText(1_000_000)).trim() || '{}'); } catch { throw new Error('Invalid MCP arguments JSON'); }
      print(await invoke(action, { server, name: value, arguments: input }));
    } else if (action === 'read') { if (!server || !value) throw new Error('Use mcp read SERVER URI'); print(await invoke('resource', { server, uri: value })); }
    else if (action === 'tasks') { if (!server) throw new Error('Use mcp tasks SERVER [TASK_ID]; use RPC for result/cancel'); print(await invoke('tasks', { server, action: value ? 'get' : 'list', ...(value ? { taskId: value } : {}) })); }
    else throw new Error('MCP: browser ENTRYPOINT, configure FILE|-, secret SERVER, connect, disconnect, pause, resume, auth, cancel, logout, ping, status, catalog, call, import|artifact SERVER (JSON stdin), read, prompt, tasks, requests, respond ID, actions, approve ID');
    return;
  }
  if (command === 'chat') { await chat(client); return; }
  if (command === 'backup') { print(await client.rpc('backup')); return; }
  if (command === 'export') { print(await client.rpc('export')); return; }
  if (command === 'login') { print(await login(client, args[0])); return; }
  if (command === 'logout') { if (!args[0]) throw new Error('Use logout provider'); print(await client.rpc('auth.logout', { provider: args[0] })); return; }
  if (command === 'auth') {
    if (['chatgpt','codex'].includes(args[0]!)) { print(await login(client, args[0] === 'codex' ? 'openai-codex' : 'openai', 'oauth', args[1] ?? 'default')); return; }
    if (args[0] === 'key') { print(await client.rpc('auth.key',{provider:args[1] ?? 'openai',key:await secretInput('API key (hidden): ')})); return; }
    if (args[0] === 'secret') { if (!args[1]) throw new Error('Use auth secret telegram.token|openai.mediaKey|openai.embeddingKey|gmail.clientSecret|brave.searchKey|openai.imageKey|openai.speechKey'); print(await client.rpc('secret.set',{name:args[1],value:await secretInput(`${args[1]} (hidden): `)})); return; }
    if (args[0] === 'select') { print(await client.rpc('auth.select',{account:args[1]})); return; }
    print(await client.rpc(args[0] === 'test' ? 'auth.test' : args[0] === 'accounts' ? 'auth.accounts' : 'auth.status')); return;
  }
  if(command==='knowledge') {
    const [action='status',...details]=args;
    if(action==='import') {
      if(!details[0])throw new Error('Use knowledge import FILE');
      const file=resolve(details[0]),info=await stat(file);
      if(!info.isFile()||info.size>loadConfig(root).config.limits.attachmentBytes)throw new Error('Not a file or attachment size limit exceeded');
      const uploaded=await client.rpc<{id:string}>('attachments.upload',{name:file.split('/').at(-1),mime:'application/octet-stream',data:(await readFile(file)).toString('base64')});
      print(await client.rpc('knowledge',{action:'import',attachmentId:uploaded.id,submission:`cli:${uploaded.id}`}));
    } else if(action==='create')print(await client.rpc('knowledge',{action,title:details.join(' ')||'Note',markdown:await stdinText(200_000),submission:`cli:${crypto.randomUUID()}`}));
    else if(action==='search')print(await client.rpc('knowledge',{action,query:details.join(' ')}));
    else if(action==='original') {
      if(!details[1])throw new Error('Use knowledge original ID OUTPUT_FILE');
      const original=await client.rpc<{data:string}>('knowledge',{action,id:details[0]});
      await import('node:fs/promises').then(fs=>fs.writeFile(resolve(details[1]!),Buffer.from(original.data,'base64'),{mode:0o600,flag:'wx'}));print({saved:true});
    } else print(await client.rpc('knowledge',{action,...(details[0]?{id:details[0]}:{})}));
    return;
  }
  if (command === 'skills') {
    const [action='list',...details] = args;
    if (action === 'build') print(await client.rpc('skills.build', { specification: details.join(' ') }));
    else if (action === 'import') { if (!details[0]) throw new Error('Use skills import DIRECTORY|SKILL.md|ZIP'); print(await client.rpc('skills.request', { action, localPath: resolve(details[0]) })); }
    else if (action === 'read') print(await client.rpc('skills.read', { name: details[0], ...(details[1] ? { path: details[1] } : {}) }));
    else if (action === 'run') { await client.rpc('skills.read', { name: details[0] }); print(await client.rpc('skills.run', { name: details[0], script: details[1], input: JSON.parse(details[2] === '-' ? await stdinText(200_000) : details[2] ?? '{}') })); }
    else if (action === 'export') {
      if (!details[1]) throw new Error('Use skills export NAME OUTPUT.zip');
      const exported = await client.rpc<{data:string}>('skills.request', { action, name: details[0] });
      await import('node:fs/promises').then(fs => fs.writeFile(resolve(details[1]!), Buffer.from(exported.data,'base64'), { mode:0o600, flag:'wx' })); print({ saved:true });
    } else if (['enable','disable','delete','rollback'].includes(action)) print(await client.rpc('skills.request', { action, name:details[0], ...(action === 'rollback' ? { version:Number(details[1]) } : {}) }));
    else if (action === 'list') print(await client.rpc('skills.request', { action }));
    else throw new Error('Skills: list, import, read, run, build, export, enable, disable, delete, rollback');
    return;
  }
  if (command === 'extensions') {
    const [action='list',...details] = args;
    if (action === 'build') print(await client.rpc('extensions.build',{specification:details.join(' ')}));
    else if (action === 'validate') print(await client.rpc('extensions.validate',{module:JSON.parse(await readFile(resolve(details[0]!),'utf8'))}));
    else if (action === 'approve') print(await client.rpc('extensions.approve',{id:details[0],hash:details[1],decision:true}));
    else if (action === 'invoke') print(await client.rpc('extensions.invoke',{id:details[0],input:JSON.parse(details[1] ?? '{}')}));
    else print(await client.rpc(`extensions.${action}`,action === 'list' || action === 'discover' ? {} : {id:details[0]}));
    return;
  }
  if (command === 'rpc') { if (!args[0]) throw new Error('Use rpc operation JSON-arguments'); print(await client.rpc(args[0],JSON.parse(args[1]==='-'?await stdinText(20_100_000):args[1]??'{}'))); return; }
  throw new Error('Commands: init, serve, chat, login, logout, auth, doctor, readiness, status, service, backup, restore, export, knowledge, skills, extensions, family, mcp, rpc (--help for usage)');
}
main().catch(error => { process.stderr.write(json({level:'error',event:'command_failed',error:error instanceof Error ? error.message : 'Command failed'})+'\n'); process.exitCode=1; });
