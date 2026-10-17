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
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Use the pinned Node.js 24.21.0 LTS runtime (see .node-version)');
  const { values, positionals } = parseArgs({ options: { instance: { type:'string',short:'i' }, name:{type:'string'}, 'confirm-original-stopped':{type:'boolean'}, 'allow-reminders':{type:'boolean'} }, allowPositionals:true, strict:true });
  const root = resolve(values.instance ?? join(homedir(),'.local','share','pico'));
  const [command = 'chat',...args] = positionals;
  const print = (value:unknown) => process.stdout.write(JSON.stringify(value,null,2).replace(/[\u202a-\u202e\u2066-\u2069]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))+'\n');
  if (command === 'init') { print({initialized:true,path:root,...initialize(root,values.name ?? 'Pico')}); return; }
  if (command === 'restore') { if (!args[0]) throw new Error('Use restore BACKUP --confirm-original-stopped with the original stopped'); await restore(root,args[0],values['confirm-original-stopped'] ?? false); print({restored:true,credentials:'Current secret store preserved; excluded from backups'}); return; }
  if (command === 'serve') {
    const daemon = await serve(root);
    process.stdout.write(json({level:'info',event:'daemon_ready',instanceId:daemon.runtime.store.config.instanceId,ownerId:daemon.runtime.store.config.ownerId})+'\n');
    const close = () => { void daemon.close().then(() => process.exit(0)); };
    process.once('SIGINT',close); process.once('SIGTERM',close); return;
  }
  if(command==='auth'&&['key','secret','chatgpt','codex'].includes(args[0]!)&&args.length>2)throw new Error('Never pass a secret as a command argument. Use the hidden terminal prompt or private piped stdin.');
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
  if (command === 'chat') { await chat(client); return; }
  if (command === 'doctor' || command === 'status') { print(await client.rpc('status')); return; }
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
  throw new Error('Commands: init, serve, chat, login, logout, auth, doctor, status, backup, restore, export, knowledge, skills, extensions, family, rpc');
}
main().catch(error => { process.stderr.write(json({level:'error',event:'command_failed',error:error instanceof Error ? error.message : 'Command failed'})+'\n'); process.exitCode=1; });
