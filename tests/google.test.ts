import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Runtime } from '../src/runtime.js';
import { rpc } from '../src/daemon.js';
import { backup, restore, exportData } from '../src/backup.js';
import { Store, hash, id, json } from '../src/store.js';
import { validate, type Envelope } from '../src/contracts.js';
import type { ExtensionAPI } from '../src/extensions.js';
import { defaultSettings, googleScopes, GoogleSettingsSchema, SCOPES, type GoogleSettings } from '../src/features/google/settings.js';
import { GmailPush } from '../src/features/google/push.js';
import { GoogleDocs, documentText } from '../src/features/google/docs.js';
import { eventBody } from '../src/features/google/calendar.js';
import { emailMime } from '../src/features/google/send.js';
import { OAuthAccount } from '../src/features/integrations/oauth.js';
import { responseJson } from '../src/features/integrations/http.js';
import { MailSync } from '../src/features/integrations/mail-sync.js';
import { googleOAuth, normalizeMail } from '../src/features/google/mail.js';
import { RemoteActions } from '../src/features/integrations/actions.js';
import type { RemoteAction } from '../src/features/integrations/contracts.js';
import { setup, source, waitFor } from './helpers.js';

const instances:ReturnType<typeof setup>[]=[],directories:string[]=[];
const instance=()=>{const s=setup();instances.push(s);return s;};
const owner=(s:ReturnType<typeof setup>):Envelope=>({ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:'',runId:id(),source,mode:'foreground'});
const state=(s:ReturnType<typeof setup>,key:string,value:unknown)=>s.store.run('INSERT INTO extension_storage(extension_id,key,value) VALUES(?,?,?) ON CONFLICT(extension_id,key) DO UPDATE SET value=excluded.value','google',key,json(value));
const readState=<T>(s:ReturnType<typeof setup>,key:string):T=>JSON.parse(s.store.get<{value:string}>('SELECT value FROM extension_storage WHERE extension_id=? AND key=?','google',key)!.value);
const invoke=async(s:ReturnType<typeof setup>,name:string,args:unknown)=>{const result=await s.runtime.invokeExtension(name,args,owner(s));return JSON.parse((result.content[0] as {text:string}).text);};
async function configure(s:ReturnType<typeof setup>,change:(settings:GoogleSettings)=>void=()=>{}):Promise<GoogleSettings>{
  const settings=defaultSettings('synthetic-client');change(settings);await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings}});
  state(s,'identity',{sub:'synthetic-account',email:'owner@example.test',email_verified:true,epoch:'synthetic-epoch'});
  await s.runtime.credentials.modify('gmail',async()=>({type:'oauth',access:'synthetic-token',refresh:'synthetic-refresh',expires:Date.now()+3600_000,scopes:googleScopes(settings)}));return settings;
}
const approve=(s:ReturnType<typeof setup>,action:RemoteAction,decision=true)=>rpc(s.runtime,{op:'extensions.google.actions.approve',args:{id:action.id,digest:action.digest,decision}});
const doc=()=>({
  documentId:'chosen-doc',title:'Synthetic document',revisionId:'rev-1',
  tabs:[{tabProperties:{tabId:'tab-1',title:'Main'},documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:'Hello world\n'}}]}}]}}}]
});
const event=()=>({id:'event-one',etag:'"etag-one"',summary:'Synthetic meeting',start:{dateTime:'2099-10-15T10:00:00Z'},end:{dateTime:'2099-10-15T11:00:00Z'}});
afterEach(async()=>{for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});vi.restoreAllMocks();});

it('is a bundled extension with generic setup, no credentials/settings in Pikobot core and safe defaults',async()=>{
  const s=instance(),modules=await rpc(s.runtime,{op:'extensions.list'}) as {id:string;setup:boolean}[];
  expect(modules.find(module=>module.id==='google')).toMatchObject({setup:true});expect(modules.some(module=>module.id==='gmail')).toBe(false);
  const setup=await rpc(s.runtime,{op:'extensions.setup',args:{id:'google'}}) as any;
  expect(setup.settings.mail.send).toBe(false);expect(setup.settings.docs.write).toBe(false);expect(setup.settings.docs.readAll).toBe(false);expect(setup.settings.calendar.write).toBe(false);
  expect(googleScopes(setup.settings)).not.toContain(SCOPES.mailSend);expect(googleScopes(setup.settings)).not.toContain(SCOPES.docsWrite);
  await expect(rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings:{...setup.settings,ownerId:'foreign'}}})).rejects.toThrow('Invalid input');
  await expect(rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings:{...setup.settings,docs:{...setup.settings.docs,readAll:'true'}}}})).rejects.toThrow('Invalid input');
  await expect(rpc(s.runtime,{op:'extensions.secret',args:{id:'google',name:'not-registered',value:'synthetic'}})).rejects.toThrow('Invalid extension secret');
  await rpc(s.runtime,{op:'extensions.secret',args:{id:'google',name:'clientSecret',value:'synthetic-private-secret'}});
  expect(await s.runtime.credentials.secret('extensions.google.clientSecret')).toBe('synthetic-private-secret');
  expect(JSON.stringify(exportData(s.store))).not.toContain('synthetic-private-secret');
  expect(s.store.all('SELECT * FROM messages')).toEqual([]);
});
it('keeps Gmail synchronization out of the short learning/compaction background phases',async()=>{
  const s=instance();await configure(s);const sync=vi.spyOn(MailSync.prototype,'sync').mockResolvedValue(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected Google request'));
  for(const phase of [1,2])await s.runtime.extensions.background({signal:AbortSignal.timeout(20_000),modelWorkAllowed:false,phase});
  expect(sync).not.toHaveBeenCalled();
  await s.runtime.extensions.background({signal:AbortSignal.timeout(120_000),modelWorkAllowed:false,phase:0});
  expect(sync).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();expect(s.faux.state.callCount).toBe(0);
});
it('attributes an aborted mail synchronization to Google rather than a later extension',async()=>{
  const s=instance();await configure(s);const abort=new AbortController();
  vi.spyOn(MailSync.prototype,'sync').mockImplementation(async()=>{abort.abort(new DOMException('Synthetic sync budget expired','TimeoutError'));throw abort.signal.reason;});
  await expect(s.runtime.extensions.background({signal:abort.signal,modelWorkAllowed:false,phase:0})).rejects.toThrow('Background extension google: Synthetic sync budget expired');
  expect(s.runtime.extensions.statuses['Google mail']).toBe('Synchronization failed; cursor preserved');
});
it('resumes an interrupted initial baseline from retained messages without notifications, but still refreshes incremental changes',async()=>{
  const s=instance(),abort=new AbortController();let interrupted=false,baseline=true;
  const message=(id:string)=>normalizeMail({id,threadId:id,internalDate:'1000',payload:{mimeType:'text/plain',body:{data:Buffer.from(`Synthetic ${baseline?'initial':'updated'} ${id}`).toString('base64url')}}});
  const read=vi.fn(async(id:string)=>{if(id==='second'&&!interrupted){interrupted=true;abort.abort(new Error('Synthetic initial sync interrupted'));throw abort.signal.reason;}return message(id);});
  const sync=new MailSync(s.store,{search:async()=>[],read,changes:async()=>({ids:baseline?['first','second']:['first'],deleted:[],cursor:baseline?'100':'101',baseline})},s.runtime.scheduler,'fixture');
  sync.rule({topic:'Synthetic',priority:'immediate',cooldownMinutes:1});
  await expect(sync.sync(abort.signal)).rejects.toThrow('Synthetic initial sync interrupted');
  expect(s.store.all('SELECT id FROM mail')).toEqual([{id:'first'}]);expect(s.store.get('SELECT cursor FROM mailbox')).toBeUndefined();
  await sync.sync();expect(read.mock.calls.map(([id])=>id)).toEqual(['first','second','second']);
  expect(s.store.get('SELECT cursor,last_sync FROM mailbox')).toMatchObject({cursor:'100',last_sync:expect.any(Number)});expect(s.store.all('SELECT * FROM outbox')).toEqual([]);
  baseline=false;await sync.sync();expect(read.mock.calls.map(([id])=>id)).toEqual(['first','second','second','first']);expect(JSON.parse(s.store.get<{data:string}>("SELECT data FROM mail WHERE id='first'")!.data).text).toBe('Synthetic updated first');
  baseline=true;await sync.sync();expect(read.mock.calls.slice(-2).map(([id])=>id)).toEqual(['first','second']);expect(JSON.parse(s.store.get<{data:string}>("SELECT data FROM mail WHERE id='first'")!.data).text).toBe('Synthetic initial first');
});
it('preserves legacy Gmail data, filters and disabled state while aliasing old enable/disable controls',async()=>{
  const s=instance();expect(()=>s.runtime.extensions.registerBuiltin('gmail',()=>{})).toThrow('reserved alias');s.store.run("INSERT INTO mailbox VALUES('gmail','100',1,NULL)");s.store.run('INSERT INTO mail VALUES(?,?,?,?,0)','original-message','{}',1,1);s.store.setMeta('extensions.disabled',json(['gmail']));
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);
  expect((await rpc(s.runtime,{op:'extensions.list'}) as any[]).find(module=>module.id==='google')).toMatchObject({enabled:false});expect(s.store.all('SELECT * FROM mail')).toHaveLength(1);
  await rpc(s.runtime,{op:'extensions.enable',args:{id:'gmail'}});expect(s.runtime.extensions.tools().map(tool=>tool.name)).toContain('google_docs');
  await rpc(s.runtime,{op:'extensions.disable',args:{id:'gmail'}});expect(s.runtime.extensions.tools().map(tool=>tool.name)).not.toContain('mail_read');expect(s.store.all('SELECT * FROM mail')).toHaveLength(1);
});
it('denies sending and remote document/calendar writes by default, without network effects',async()=>{
  const s=instance();await configure(s,settings=>{settings.docs.enabled=true;settings.docs.documentIds=['chosen-doc'];settings.calendar.enabled=true;});const fetch=vi.spyOn(globalThis,'fetch');
  await expect(invoke(s,'google_mail',{action:'prepare_send',to:['recipient@example.test'],subject:'Hello',text:'Synthetic'})).rejects.toThrow('sending disabled');
  await expect(invoke(s,'google_docs',{action:'create',title:'Synthetic'})).rejects.toThrow('writes disabled');
  await expect(invoke(s,'google_calendar',{action:'create',calendarId:'primary',title:'Meeting',start:'2099-10-15T10:00:00Z',end:'2099-10-15T11:00:00Z'})).rejects.toThrow('writes disabled');
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['ephemeral','scheduled','review','untrusted','repair'])('denies Google mutations in %s execution',async mode=>{
  const s=instance();await configure(s,settings=>{settings.docs.enabled=true;settings.docs.readAll=true;settings.docs.write=true;settings.docs.documentIds=['chosen-doc'];});const context={...owner(s),conversationId:s.runtime.newConversation().id,mode:mode==='ephemeral'?'ephemeral':mode==='scheduled'?'scheduled':mode==='review'?'review':'foreground'} as Envelope;
  if(mode==='untrusted')context.source={...source,trustedOwner:false};
  if(mode==='repair')(s.runtime as any).citationRepair.add(context.runId);
  if(mode!=='ephemeral')s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',context.runId,context.conversationId,context.runId,json(context),'running',1,1);
  const fetch=vi.spyOn(globalThis,'fetch'),tool=s.runtime.availableTools(context).find(tool=>tool.name==='google_docs')!;
  await expect(tool.execute('denied',{action:'create',title:'Must not create'})).rejects.toThrow('foreground');expect(fetch).not.toHaveBeenCalled();expect(s.store.all("SELECT * FROM extension_storage WHERE key LIKE 'action:%'")).toEqual([]);
});
it('requires extra consent even when a write toggle is enabled',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});await s.runtime.credentials.modify('gmail',async current=>({...current!,type:'oauth',access:'synthetic-token',refresh:'synthetic-refresh',expires:Date.now()+3600_000,scopes:[SCOPES.mailRead]}));
  await expect(invoke(s,'google_mail',{action:'prepare_send',to:['recipient@example.test'],subject:'Hello',text:'Synthetic'})).rejects.toThrow('consent');
});
it('stages an exact email, supports one human-approved send, and refuses altered/reused approval',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');expect(options?.redirect).toBe('error');expect(s.store.get('SELECT hash FROM deletions WHERE hash=?',hash(`remote-action:google:${action.id}`))).toBeDefined();return Response.json({id:'sent-message',threadId:'sent-thread'});});
  const {action}=await invoke(s,'google_mail',{action:'prepare_send',to:['recipient@example.test'],bcc:['private@example.test'],subject:'Caffè ☕',text:'Synthetic body'}) as {action:RemoteAction};expect(fetch).not.toHaveBeenCalled();
  await expect(rpc(s.runtime,{op:'extensions.google.actions.approve',args:{id:action.id,digest:'0'.repeat(64),decision:true}})).rejects.toThrow('Changed');
  expect(await approve(s,action)).toMatchObject({status:'accepted',result:{messageId:'sent-message'}});
  const mime=Buffer.from(JSON.parse(fetch.mock.calls[0]![1]!.body as string).raw,'base64url').toString('utf8');expect(mime).toContain('Bcc: private@example.test');expect(mime).toContain(Buffer.from('Synthetic body').toString('base64'));
  expect(await invoke(s,'google_actions',{action:'read',id:action.id})).toMatchObject({action:{status:'accepted',result:{messageId:'sent-message'}}});expect(await invoke(s,'google_actions',{action:'list',limit:1})).toMatchObject({actions:[{id:action.id,status:'accepted'}],total:1,nextOffset:null});
  await expect(invoke(s,'google_actions',{action:'approve',id:action.id,decision:true})).rejects.toThrow('Invalid input');
  await expect(approve(s,action)).rejects.toThrow('consumed');expect(fetch).toHaveBeenCalledTimes(1);
});
it('paginates local action receipts and permits ephemeral inspection without durable mutation or a Google request',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});const first=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'One',text:'Synthetic'}),second=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Two',text:'Synthetic'});
  const page=await invoke(s,'google_actions',{action:'list',limit:1});expect(page).toMatchObject({total:2,nextOffset:1});expect(await rpc(s.runtime,{op:'extensions.google.actions.list',args:{limit:1}})).toEqual(page);const next=await invoke(s,'google_actions',{action:'list',offset:1,limit:1});expect(next.nextOffset).toBeNull();expect(new Set([...page.actions,...next.actions].map(action=>action.id))).toEqual(new Set([first.action.id,second.action.id]));
  const before=s.store.all('SELECT * FROM extension_storage'),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected integration request')),session=s.runtime.newConversation('Synthetic legacy ephemeral',true),context={...owner(s),mode:'ephemeral' as const,conversationId:session.id};
  const result=await s.runtime.availableTools(context).find(tool=>tool.name==='google_actions')!.execute('inspect',{action:'read',id:first.action.id});expect(JSON.parse((result.content[0] as {text:string}).text)).toMatchObject({action:{status:'pending'}});expect(s.store.all('SELECT * FROM extension_storage')).toEqual(before);expect(fetch).not.toHaveBeenCalled();
});
it('refuses expired and tampered exact actions without network effects',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});const fetch=vi.spyOn(globalThis,'fetch'),expired=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Expiry',text:'Synthetic'}),tampered=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Integrity',text:'Synthetic'});
  const stored=readState<RemoteAction>(s,`action:${tampered.action.id}`);stored.payload.text='Altered outside approval';state(s,`action:${stored.id}`,stored);await expect(approve(s,tampered.action)).rejects.toThrow('integrity');
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60_000);await expect(approve(s,expired.action)).rejects.toThrow('expired');expect(fetch).not.toHaveBeenCalled();
});
it('rejects header injection, unknown properties and excessive combined recipients before effects',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});const fetch=vi.spyOn(globalThis,'fetch');
  await expect(invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test\r\nBcc: stolen@example.test'],subject:'Hello',text:'Synthetic'})).rejects.toThrow('Invalid input');
  await expect(invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Hello\nBcc: stolen',text:'Synthetic'})).rejects.toThrow('Invalid input');
  await expect(invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Hello',text:'Synthetic',from:'foreign@example.test'})).rejects.toThrow('Invalid input');
  const to=Array.from({length:30},(_,i)=>`owner${i}@example.test`);await expect(invoke(s,'google_mail',{action:'prepare_send',to,cc:to,subject:'Hello',text:'Synthetic'})).rejects.toThrow('50 recipients');expect(fetch).not.toHaveBeenCalled();
});
it('does not retry a lost Gmail acknowledgment and invalidates approvals when settings change',async()=>{
  const s=instance(),settings=await configure(s,value=>{value.mail.send=true;});const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Synthetic lost acknowledgment'));
  const {action}=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Hello',text:'Synthetic'});expect(await approve(s,action)).toMatchObject({status:'uncertain'});expect(await invoke(s,'google_actions',{action:'read',id:action.id})).toMatchObject({action:{status:'uncertain'}});await expect(approve(s,action)).rejects.toThrow('consumed');expect(fetch).toHaveBeenCalledTimes(1);
  const next=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'New',text:'Synthetic'});settings.mail.send=false;await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings}});await expect(approve(s,next.action)).rejects.toThrow('permissions changed');expect(fetch).toHaveBeenCalledTimes(1);
});
it('serializes concurrent approval consumption instead of sending twice',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});let release!:(value:Response)=>void;
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Promise(resolve=>{release=resolve;}));const {action}=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Hello',text:'Synthetic'});
  const first=approve(s,action);await waitFor(()=>!!release);await expect(approve(s,action)).rejects.toThrow('consumed');release(Response.json({id:'one-message',threadId:'one-thread'}));await first;expect(fetch).toHaveBeenCalledTimes(1);
});
it('binds attachment bytes, names and source lineage to approval, and refuses stale attachments',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});const attachmentId=s.runtime.media.save(Buffer.from('Synthetic attachment'),'report.txt','text/plain');
  const {action}=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Report',text:'See attached',attachments:[{attachmentId}]});expect(action.payload.attachments[0]).toMatchObject({hash:hash('Synthetic attachment'),bytes:20});
  s.store.run("UPDATE attachments SET name='changed.txt' WHERE id=?",attachmentId);const fetch=vi.spyOn(globalThis,'fetch');expect(await approve(s,action)).toMatchObject({status:'rejected'});expect(fetch).not.toHaveBeenCalled();
});
it('erases source-dependent pending actions and prevents an old restore from resurrecting them',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});const memory=s.runtime.remember('synthetic-key','Synthetic private draft source'),sourceId=s.runtime.memory.read(memory.id).memory.source_id;
  const context=owner(s),conversation=s.runtime.newConversation();context.conversationId=conversation.id;
  s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',context.runId,conversation.id,context.runId,json(context),'running',1,1);s.store.linkSource(context.runId,sourceId);
  const result=await s.runtime.availableTools(context).find(tool=>tool.name==='google_mail')!.execute('draft',{action:'prepare_send',to:['safe@example.test'],subject:'Private',text:'Synthetic'}),action=JSON.parse((result.content[0] as {text:string}).text).action;
  const snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pikobot-google-backup-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});await s.runtime.forget(memory.id);
  await expect(rpc(s.runtime,{op:'extensions.google.actions.review',args:{id:action.id}})).rejects.toThrow('forgotten');
  await s.runtime.close();s.store.close();await restore(s.root,external,true);s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);expect(s.store.get('SELECT * FROM extension_storage WHERE key=?',`action:${action.id}`)).toBeUndefined();
});
it('keeps attempted action tombstones across restoration of an older pending draft',async()=>{
  const s=instance();await configure(s,settings=>{settings.mail.send=true;});const {action}=await invoke(s,'google_mail',{action:'prepare_send',to:['safe@example.test'],subject:'Restore',text:'Synthetic'});
  const snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pikobot-google-attempt-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'accepted-once',threadId:'thread'}));await approve(s,action);await s.runtime.close();s.store.close();await restore(s.root,external,true);s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);
  expect(s.store.get('SELECT hash FROM deletions WHERE hash=?',hash(`remote-action:google:${action.id}`))).toBeDefined();expect(await invoke(s,'google_actions',{action:'read',id:action.id})).toMatchObject({action:{status:'uncertain'}});await expect(approve(s,action)).rejects.toThrow('uncertain');
});
it.each([false,undefined])('reads selected document tabs and denies unselected documents unless explicitly broadened (readAll=%s)',async readAll=>{
  const s=instance();await configure(s,settings=>{settings.docs.enabled=true;settings.docs.readAll=readAll;settings.docs.documentIds=['chosen-doc'];});const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json(doc()));
  const first=await invoke(s,'google_docs',{action:'read',documentId:'chosen-doc',maxChars:5});expect(first).toMatchObject({text:'# Mai',nextOffset:5,completeSource:false,tabs:[{id:'tab-1',title:'Main'}]});expect(String(fetch.mock.calls[0]![0])).toContain('includeTabsContent=true');
  await expect(invoke(s,'google_docs',{action:'read',documentId:'not-selected'})).rejects.toThrow('not selected');
  await expect(invoke(s,'google_docs',{action:'read',documentId:'not-selected',readAll:true})).rejects.toThrow('Invalid input');expect(fetch).toHaveBeenCalledTimes(1);
  await expect(invoke(s,'google_docs',{action:'read',documentId:'chosen-doc',fromOffset:1000})).rejects.toThrow('offset');
});
it('reads any account-accessible Google Doc only when read-all is enabled, without bypassing Google permissions or importing in bulk',async()=>{
  const s=instance(),settings=await configure(s,value=>{value.docs.enabled=true;value.docs.readAll=true;value.docs.discovery=true;});
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{const documentId=new URL(String(url)).pathname.split('/').at(-1)!;if(documentId==='files')return Response.json({files:[{id:'owned-doc',name:'Synthetic'}],nextPageToken:'next'});return documentId==='forbidden-doc'?Response.json({},{status:403}):Response.json({...doc(),documentId});});
  for(const documentId of ['owned-doc','shared-doc'])expect(await invoke(s,'google_docs',{action:'read',documentId})).toMatchObject({documentId,origin:'external:google-docs',text:expect.stringContaining('Hello world')});
  await expect(invoke(s,'google_docs',{action:'read',documentId:'forbidden-doc'})).rejects.toThrow('HTTP 403');
  expect(await invoke(s,'google_docs',{action:'search',query:''})).toMatchObject({files:[{id:'owned-doc'}],nextPageToken:'next',note:expect.stringContaining('Read/import any Google Doc')});
  expect(s.store.all('SELECT * FROM documents')).toEqual([]);expect(s.store.all('SELECT * FROM attachments')).toEqual([]);expect(fetch).toHaveBeenCalledTimes(4);
  settings.docs.enabled=false;await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings}});
  await expect(invoke(s,'google_docs',{action:'read',documentId:'owned-doc'})).rejects.toThrow('Docs disabled');expect(fetch).toHaveBeenCalledTimes(4);
});
it.each([false,true])('preserves raw Google snapshots and external provenance without reimporting erased sources (readAll=%s)',async readAll=>{
  const s=instance();await configure(s,settings=>{settings.docs.enabled=true;settings.docs.readAll=readAll;settings.docs.documentIds=readAll?[]:['chosen-doc'];});vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json(doc()));
  const imported=await invoke(s,'google_docs',{action:'import',documentId:'chosen-doc'});expect(s.runtime.knowledge.read(imported.documentId).text).toContain('Hello world');expect(s.runtime.knowledge.original(imported.documentId).mime).toBe('application/json');
  const conversion=JSON.parse(s.store.get<{conversion:string}>('SELECT conversion FROM document_revisions WHERE document_id=?',imported.documentId)!.conversion);expect(conversion.authoredBy).toBe('external:google-docs');
  expect(await invoke(s,'google_docs',{action:'import',documentId:'chosen-doc'})).toMatchObject({documentId:imported.documentId,reused:true});
  await s.runtime.deleteKnowledge(imported.documentId,true);await expect(invoke(s,'google_docs',{action:'import',documentId:'chosen-doc'})).rejects.toThrow('reimport denied');
});
it.each([false,true])('blocks forgotten remote snapshots and changed revisions after a pre-import restore (readAll=%s)',async readAll=>{
  const s=instance();await configure(s,settings=>{settings.docs.enabled=true;settings.docs.readAll=readAll;settings.docs.documentIds=readAll?[]:['chosen-doc'];});const snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pikobot-google-pre-import-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});let revision='rev-1';vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({...doc(),revisionId:revision}));
  const first=await invoke(s,'google_docs',{action:'import',documentId:'chosen-doc'});revision='rev-2';const second=await invoke(s,'google_docs',{action:'import',documentId:'chosen-doc'});expect(second.documentId).not.toBe(first.documentId);
  const sourceId=s.runtime.knowledge.document(first.documentId).source_id;await s.runtime.deleteKnowledge(first.documentId,true);expect(s.store.get('SELECT hash FROM deletions WHERE hash=?',hash(`source:${sourceId}`))).toBeDefined();expect(s.store.all('SELECT id FROM documents WHERE deleted_at IS NULL')).toEqual([]);
  await s.runtime.close();s.store.close();await restore(s.root,external,true);s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);revision='rev-after-restore';await expect(invoke(s,'google_docs',{action:'import',documentId:'chosen-doc'})).rejects.toThrow('reimport denied');expect(s.store.all('SELECT * FROM attachments')).toEqual([]);
});
it('keeps document reads working after disabling writes and accepting a narrower refresh grant',async()=>{
  const s=instance(),settings=await configure(s,value=>{value.docs.enabled=true;value.docs.write=true;value.docs.documentIds=['chosen-doc'];});settings.docs.write=false;await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings}});
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url)==='https://oauth2.googleapis.com/token'?Response.json({access_token:'narrow-synthetic',expires_in:3600,scope:googleScopes(settings).join(' ')}):Response.json(doc()));
  expect((await rpc(s.runtime,{op:'extensions.google.status'}) as any).consentRequired).toEqual([]);expect(await invoke(s,'google_docs',{action:'read',documentId:'chosen-doc'})).toMatchObject({documentId:'chosen-doc'});
  await s.runtime.credentials.modify('gmail',async current=>({...current!,type:'oauth',access:'expired',refresh:'synthetic-refresh',expires:0,scopes:googleScopes({...settings,docs:{...settings.docs,write:true}})}));expect(await invoke(s,'google_docs',{action:'read',documentId:'chosen-doc'})).toMatchObject({documentId:'chosen-doc'});
  await expect(invoke(s,'google_docs',{action:'append',documentId:'chosen-doc',expectedRevision:'rev-1',tabId:'tab-1',text:'Not allowed'})).rejects.toThrow('disabled');
});
it.each([false,true])('keeps writes selected and revision/approval-bound even with broad reads (readAll=%s)',async readAll=>{
  const s=instance(),settings=await configure(s,value=>{value.docs.enabled=true;value.docs.readAll=readAll;value.docs.write=true;value.docs.documentIds=['chosen-doc'];});let revision='rev-1';
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{if(options?.method==='POST'){const body=JSON.parse(options.body as string);expect(body.writeControl).toEqual({requiredRevisionId:'rev-1'});expect(body.requests[0].replaceAllText.tabsCriteria).toEqual({tabIds:['tab-1']});return Response.json({writeControl:{requiredRevisionId:'rev-2'},replies:[{replaceAllText:{occurrencesChanged:1}}]});}return Response.json({...doc(),revisionId:revision});});
  const unselected={documentId:'not-selected',expectedRevision:'rev-1',tabId:'tab-1',text:'Must not write'};
  await expect(invoke(s,'google_docs',{action:'append',...unselected})).rejects.toThrow('not selected');
  await expect(new GoogleDocs(new OAuthAccount(s.runtime.credentials,googleOAuth(settings.clientId,googleScopes(settings))),settings).write('docs.append',unselected,AbortSignal.timeout(5000))).rejects.toThrow('not selected');expect(fetch).not.toHaveBeenCalled();
  const {action}=await invoke(s,'google_docs',{action:'replace',documentId:'chosen-doc',expectedRevision:'rev-1',tabId:'tab-1',find:'Hello',replace:'Ciao'});expect(fetch).not.toHaveBeenCalled();expect(await approve(s,action)).toMatchObject({status:'accepted'});
  const stale=await invoke(s,'google_docs',{action:'append',documentId:'chosen-doc',expectedRevision:'rev-1',tabId:'tab-1',text:'Append'});revision='rev-new';expect(await approve(s,stale.action)).toMatchObject({status:'rejected'});expect(fetch.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it('labels document representation limits and bounds deeply nested/tabbed content',()=>{
  const raw=doc();raw.tabs[0]!.documentTab.body.content[0]!.paragraph.elements[0]!.textRun.content='x'.repeat(210_000);expect(documentText(raw)).toMatchObject({truncated:true});expect(documentText(raw).text.length).toBe(200_000);
  let tab:any={documentTab:{body:{content:[]}},tabProperties:{tabId:'deep'}};for(let i=0;i<40;i++)tab={childTabs:[tab]};expect(()=>documentText({...doc(),tabs:[tab]})).toThrow('tab limit');
});
it('uses stable message-bound MIME-part references instead of rotating Gmail download tokens',()=>{
  const raw=(messageId:string,token:string)=>({id:messageId,threadId:'thread-one',internalDate:'1000',payload:{mimeType:'multipart/mixed',parts:[{partId:'1.0',filename:'same-name.pdf',mimeType:'application/pdf',body:{attachmentId:token,size:20}},{partId:'1.1',filename:'same-name.pdf',mimeType:'application/pdf',body:{attachmentId:'other-token',size:20}}]}});
  const first=normalizeMail(raw('mail-one','token-before')),next=normalizeMail(raw('mail-one','token-after')),other=normalizeMail(raw('mail-two','token-before'));
  expect(first.attachments[0]!.id).toBe(next.attachments[0]!.id);
  expect(first.attachments[0]!.id).not.toBe(first.attachments[1]!.id);
  expect(first.attachments[0]!.id).not.toBe(other.attachments[0]!.id);
  expect(JSON.stringify(first.attachments)).not.toContain('token-before');
});
it('imports and reads a PDF after Gmail rotates its download token, then reuses the stable import',async()=>{
  const s=instance();await configure(s);const bytes=readFileSync(join(import.meta.dirname,'fixtures/knowledge/digital.pdf'));let reads=0,downloads=0;
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{
    const target=new URL(String(url));
    if(target.pathname.includes('/attachments/')){downloads++;expect(target.pathname.endsWith(`/current-token-${reads}`)).toBe(true);return Response.json({data:bytes.toString('base64url')});}
    reads++;return Response.json({id:'mail-one',threadId:'thread-one',internalDate:'1000',payload:{mimeType:'multipart/mixed',parts:[{partId:'1.0',filename:'report.pdf',mimeType:'application/pdf',body:{attachmentId:`current-token-${reads}`,size:bytes.length}}]}});
  });
  const listed=await invoke(s,'mail_read',{id:'mail-one'}),reference=listed.message.attachments[0].id,args={action:'import_attachment',messageId:'mail-one',attachmentId:reference};
  const imported=await invoke(s,'google_mail',args);
  expect(s.runtime.knowledge.original(imported.documentId).bytes).toEqual(bytes);
  expect(await invoke(s,'documents',{action:'read',id:imported.documentId})).toMatchObject({extraction:'ready',text:expect.stringContaining('PDF-901')});
  expect(await invoke(s,'google_mail',args)).toMatchObject({documentId:imported.documentId,reused:true});
  expect(downloads).toBe(1);expect(reads).toBe(3);expect(fetch.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
  expect(s.faux.state.callCount).toBe(0);
  await s.runtime.deleteKnowledge(imported.documentId,false);
  await expect(invoke(s,'google_mail',args)).rejects.toThrow('reimport denied');expect(downloads).toBe(1);
});
it.each(['another message','wrong response message','duplicate part reference','stale opaque token'] as const)('refuses %s without downloading or guessing by filename',async scenario=>{
  const s=instance();await configure(s);
  const raw={id:'mail-one',threadId:'thread-one',internalDate:'1000',payload:{mimeType:'multipart/mixed',parts:[{partId:'1.0',filename:'report.pdf',mimeType:'application/pdf',body:{attachmentId:'current-token',size:20}}]}};
  const reference=normalizeMail(raw).attachments[0]!.id;
  if(scenario==='wrong response message'||scenario==='another message')raw.id='mail-two';
  if(scenario==='duplicate part reference')raw.payload.parts.push({...raw.payload.parts[0]!,body:{attachmentId:'second-token',size:20}});
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(raw));
  await expect(invoke(s,'google_mail',{action:'import_attachment',messageId:scenario==='another message'?'mail-two':'mail-one',attachmentId:scenario==='stale opaque token'?'expired-token':reference})).rejects.toThrow(/selected message|stale|ambiguous/);
  expect(fetch.mock.calls.some(([url])=>String(url).includes('/attachments/'))).toBe(false);
  expect(s.store.all('SELECT * FROM attachments')).toEqual([]);expect(s.store.all('SELECT * FROM documents')).toEqual([]);
});

it('accepts an exact current legacy token but stores/reuses the canonical MIME-part identity',async()=>{
  const s=instance();await configure(s);const bytes=Buffer.from('Synthetic file'),raw={id:'mail-one',threadId:'thread-one',internalDate:'1000',payload:{partId:'1',filename:'report.txt',mimeType:'text/plain',body:{attachmentId:'current-token',size:bytes.length}}};
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>Response.json(String(url).includes('/attachments/')?{data:bytes.toString('base64url')}:String(url).includes('/threads/')?{messages:[raw]}:raw));
  const thread=await invoke(s,'google_mail',{action:'thread',threadId:'thread-one'}),reference=thread.messages[0].attachments[0].id;
  const imported=await invoke(s,'google_mail',{action:'import_attachment',messageId:'mail-one',attachmentId:'current-token'});
  expect(await invoke(s,'google_mail',{action:'import_attachment',messageId:'mail-one',attachmentId:reference})).toMatchObject({documentId:imported.documentId,reused:true});
  expect(s.runtime.knowledge.document(imported.documentId).submission).toBe(`google-mail:mail-one:${reference}`);
  expect(fetch.mock.calls.filter(([url])=>String(url).includes('/attachments/'))).toHaveLength(1);
});
it.each(['metadata size','actual size'] as const)('enforces the configured attachment limit against %s',async scenario=>{
  const s=instance();await configure(s);s.config.limits.attachmentBytes=8;const raw={id:'mail-one',threadId:'thread-one',internalDate:'1000',payload:{partId:'1',filename:'report.txt',mimeType:'text/plain',body:{attachmentId:'current-token',size:scenario==='metadata size'?9:8}}};
  const reference=normalizeMail(raw).attachments[0]!.id,fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>Response.json(String(url).includes('/attachments/')?{data:Buffer.alloc(9).toString('base64url')}:raw));
  await expect(invoke(s,'google_mail',{action:'import_attachment',messageId:'mail-one',attachmentId:reference})).rejects.toThrow(/byte limit|size limit/i);
  expect(fetch.mock.calls.filter(([url])=>String(url).includes('/attachments/'))).toHaveLength(scenario==='metadata size'?0:1);
  expect(s.store.all('SELECT * FROM attachments')).toEqual([]);expect(s.store.all('SELECT * FROM documents')).toEqual([]);
});
it.each(['cancel','forget'] as const)('does not download or retain an attachment after %s during metadata selection',async scenario=>{
  const s=instance();await configure(s);const controller=new AbortController(),context={...owner(s),conversationId:s.runtime.newConversation().id};
  s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',context.runId,context.conversationId,context.runId,json(context),'running',1,1);
  const raw={id:'mail-one',threadId:'thread-one',internalDate:'1000',payload:{partId:'1',filename:'report.pdf',mimeType:'application/pdf',body:{attachmentId:'current-token',size:20}}},reference=normalizeMail(raw).attachments[0]!.id;
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
    if(scenario==='cancel')controller.abort(new Error('Mail import cancelled'));
    else s.store.run('INSERT INTO deletions VALUES(?,?)',hash('source:mail-one'),Date.now());
    return Response.json(raw);
  });
  await expect(s.runtime.availableTools(context).find(tool=>tool.name==='google_mail')!.execute('import',{action:'import_attachment',messageId:'mail-one',attachmentId:reference},controller.signal)).rejects.toThrow(/cancelled|forgotten/);
  expect(fetch.mock.calls.some(([url])=>String(url).includes('/attachments/'))).toBe(false);
  expect(s.store.all('SELECT * FROM attachments')).toEqual([]);expect(s.store.all('SELECT * FROM documents')).toEqual([]);expect(s.store.all('SELECT * FROM mail')).toEqual([]);
});

it('imports a selected mail attachment once with verified media metadata and denies forgotten originals',async()=>{
  const s=instance();await configure(s);const bytes=Buffer.from('Synthetic file'),partId='a'.repeat(500),raw={id:'mail-one',threadId:'thread-one',internalDate:'1000',payload:{mimeType:'multipart/mixed',parts:[{mimeType:'text/plain',body:{data:Buffer.from('Synthetic message').toString('base64url')}},{filename:'original.bin',mimeType:'application/pdf',body:{attachmentId:partId,size:bytes.length}}]}};
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>Response.json(String(url).includes('/attachments/')?{data:bytes.toString('base64url')}:raw)),args={action:'import_attachment',messageId:'mail-one',attachmentId:partId};
  const imported=await invoke(s,'google_mail',args);expect(s.runtime.knowledge.original(imported.documentId).mime).toBe('application/octet-stream');expect(await invoke(s,'google_mail',args)).toMatchObject({documentId:imported.documentId,reused:true});expect(fetch.mock.calls.filter(call=>String(call[0]).includes('/attachments/'))).toHaveLength(1);expect(s.store.all('SELECT * FROM attachments')).toHaveLength(1);
  await s.runtime.deleteKnowledge(imported.documentId,true);await expect(invoke(s,'google_mail',args)).rejects.toThrow('reimport denied');expect(s.store.all('SELECT * FROM attachments')).toEqual([]);
});
it('retains full thread responses without downloading each message again, including forgotten-source filtering',async()=>{
  const s=instance();await configure(s);s.store.run('INSERT INTO deletions(hash,deleted_at) VALUES(?,?)',hash('source:erased-mail'),Date.now());
  const message=(id:string)=>({id,threadId:'thread-one',internalDate:'1000',payload:{mimeType:'text/plain',body:{data:Buffer.from('Synthetic').toString('base64url')}}}),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({messages:[message('mail-one'),message('erased-mail')]}));
  expect((await invoke(s,'google_mail',{action:'thread',threadId:'thread-one'})).messages).toHaveLength(2);expect(s.store.all('SELECT id FROM mail')).toEqual([{id:'mail-one'}]);expect(fetch).toHaveBeenCalledTimes(1);
});
it('bounds HTTP bodies without trusting content-length and does not expose malformed credentials in errors',async()=>{
  const cancelled=vi.fn(),stream=new ReadableStream<Uint8Array>({start:controller=>controller.enqueue(Buffer.alloc(32)),cancel:cancelled});await expect(responseJson(new Response(stream),8)).rejects.toThrow('byte limit');expect(cancelled).toHaveBeenCalledTimes(1);
  await expect(responseJson(new Response('{"access_token":"synthetic-private-token'))).rejects.toThrow('Integration returned malformed JSON');
});
it('combines selected Google events and all-day dates with local agenda without creating local copies',async()=>{
  const s=instance();await configure(s,settings=>{settings.calendar.enabled=true;});vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({timeZone:'Europe/Rome',items:[event(),{id:'all-day',etag:'"two"',summary:'Holiday',start:{date:'2099-10-15'},end:{date:'2099-10-16'}}]}));
  const agenda=await invoke(s,'agenda',{date:'2099-10-15',timezone:'Europe/Rome',limit:1});expect(agenda).toMatchObject({total:2,totalExact:true,nextOffset:1,items:[{allDay:true,origin:'google:primary'}]});expect(s.store.all('SELECT * FROM calendar_events')).toEqual([]);expect(s.store.all('SELECT * FROM schedules')).toEqual([]);
});
it('reports unavailable external agenda as incomplete, not an empty verified calendar',async()=>{
  const s=instance();await configure(s,settings=>{settings.calendar.enabled=true;});vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({}, {status:403}));
  const agenda=await invoke(s,'agenda',{date:'2099-10-15'});expect(agenda).toMatchObject({totalExact:false,truncated:true});expect(agenda.warnings.join(' ')).toContain('external agenda unavailable');
});
it('rejects unselected calendars and preserves page tokens and recurrence expansion',async()=>{
  const s=instance();await configure(s,settings=>{settings.calendar.enabled=true;});const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({items:[event()],nextPageToken:'next-page'}));
  const result=await invoke(s,'google_calendar',{action:'list',calendarId:'primary',from:'2099-10-15T00:00:00Z',to:'2099-10-16T00:00:00Z'});expect(result.nextPageToken).toBe('next-page');expect(String(fetch.mock.calls[0]![0])).toContain('singleEvents=true');
  await expect(invoke(s,'google_calendar',{action:'list',calendarId:'foreign',from:'2099-10-15T00:00:00Z',to:'2099-10-16T00:00:00Z'})).rejects.toThrow('not selected');
  await expect(invoke(s,'google_calendar',{action:'list',from:'2099-10-15T00:00:00Z',to:'2099-10-16T00:00:00Z'})).rejects.toThrow('Invalid input');expect(fetch).toHaveBeenCalledTimes(1);
});
it('checks Calendar ETags and blocks guest/series writes even after approval',async()=>{
  const s=instance();await configure(s,settings=>{settings.calendar.enabled=true;settings.calendar.write=true;});let current:any=event();const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>options?.method==='PATCH'?Response.json({...event(),summary:'Moved'}):Response.json(current));
  const args={action:'update',calendarId:'primary',eventId:'event-one',expectedEtag:'"etag-one"',title:'Moved'};
  const first=await invoke(s,'google_calendar',args);expect(await approve(s,first.action)).toMatchObject({status:'accepted'});expect((fetch.mock.calls.find(call=>call[1]?.method==='PATCH')![1]!.headers as any)['If-Match']).toBe('"etag-one"');
  current={...event(),etag:'"new"'};const stale=await invoke(s,'google_calendar',args);expect(await approve(s,stale.action)).toMatchObject({status:'rejected'});
  current={...event(),attendees:[{email:'guest@example.test'}]};const guest=await invoke(s,'google_calendar',args);expect(await approve(s,guest.action)).toMatchObject({status:'rejected'});
  current={...event(),attendeesOmitted:true};const omitted=await invoke(s,'google_calendar',args);expect(await approve(s,omitted.action)).toMatchObject({status:'rejected'});
  current={...event(),recurrence:['RRULE:FREQ=DAILY']};const series=await invoke(s,'google_calendar',args);expect(await approve(s,series.action)).toMatchObject({status:'rejected'});expect(fetch.mock.calls.filter(call=>call[1]?.method==='PATCH')).toHaveLength(1);
});
it('validates Calendar all-day exclusive ends, explicit offsets, duration and unknown invitation fields',()=>{
  expect(eventBody({title:'Holiday',start:'2099-10-15',end:'2099-10-16'},'Europe/Rome')).toMatchObject({start:{date:'2099-10-15'},end:{date:'2099-10-16'}});
  expect(()=>eventBody({start:'2099-02-31',end:'2099-03-02'},'UTC')).toThrow('Invalid calendar');expect(()=>eventBody({start:'2099-10-15T10:00:00',end:'2099-10-15T11:00:00'},'UTC')).toThrow('offset');expect(()=>eventBody({start:'2099-10-15',end:'2099-10-15'},'UTC')).toThrow('positive');
  expect(()=>validate(GoogleSettingsSchema,{...defaultSettings(),mail:{...defaultSettings().mail,send:true,autoReply:true}})).toThrow('Invalid input');
});
it('binds Google consent to a verified account and rejects account changes without replacing credentials',async()=>{
  const s=instance();await configure(s);const realFetch=globalThis.fetch;
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'new-synthetic',refresh_token:'new-refresh',expires_in:3600,scope:googleScopes(defaultSettings()).join(' ')});if(String(url)==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'foreign-account',email:'foreign@example.test',email_verified:true});return realFetch(url,options);});
  const login=await rpc(s.runtime,{op:'extensions.google.auth'}) as {url:string;redirectUri:string};await realFetch(`${login.redirectUri}?state=${new URL(login.url).searchParams.get('state')}&code=synthetic-code`);expect(await rpc(s.runtime,{op:'extensions.google.status'})).toMatchObject({authentication:'failed',authenticationFailure:{stage:'account-validation'}});expect((await s.runtime.credentials.read('gmail') as any).access).toBe('synthetic-token');expect(fetch.mock.calls).toHaveLength(2);
});
it('refreshes only explicit scopes, propagates cancellation, and refuses authenticated redirects',async()=>{
  const s=instance();await configure(s);await s.runtime.credentials.modify('gmail',async current=>({...current!,type:'oauth',access:'expired',refresh:'synthetic-refresh',expires:0,scopes:[SCOPES.mailRead]}));const account=new OAuthAccount(s.runtime.credentials,googleOAuth('synthetic-client'));
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{expect(options?.redirect).toBe('error');return Response.json({access_token:'broader',expires_in:3600,scope:`${SCOPES.mailRead} ${SCOPES.mailSend}`});});await expect(account.token()).rejects.toThrow('broadened');expect((await s.runtime.credentials.read('gmail') as any).access).toBe('expired');
  const abort=new AbortController();abort.abort();await expect(account.token(abort.signal)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([{access_token:123,expires_in:3600},{access_token:'synthetic',refresh_token:'',expires_in:3600},{access_token:'synthetic',expires_in:1e100},{access_token:'synthetic',expires_in:3600,scope:42}])('rejects malformed OAuth grants without replacing credentials (%j)',async tokens=>{
  const s=instance();await configure(s);await s.runtime.credentials.modify('gmail',async current=>({...current!,type:'oauth',access:'expired',refresh:'synthetic-refresh',expires:0}));vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(tokens));const account=new OAuthAccount(s.runtime.credentials,googleOAuth('synthetic-client'));
  await expect(account.token()).rejects.toThrow('Invalid OAuth response');expect((await s.runtime.credentials.read('gmail') as any).access).toBe('expired');
});

function pushFixture(){
  const values=new Map<string,unknown>(),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),secret=json({type:'service_account',client_email:'subscriber@synthetic-project.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})});
  const api={credentials:{secret:async()=>secret},storage:{get:(key:string)=>values.get(key),set:(key:string,value:unknown)=>values.set(key,value)},setStatus:()=>{}} as unknown as ExtensionAPI;
  const account={request:async()=>({historyId:'100',expiration:String(Date.now()+3*86_400_000)})} as unknown as OAuthAccount;
  return {api,account,values};
}
it('renews Gmail watches and acknowledges push hints only after durable history catch-up',async()=>{
  const fixture=pushFixture(),sync=vi.fn().mockResolvedValue(false),push=new GmailPush(fixture.api,fixture.account,{topic:'projects/synthetic-project/topics/mail-events',subscription:'projects/synthetic-project/subscriptions/mail-events'},'owner@example.test',sync);
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{expect(options?.redirect).toBe('error');if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'subscriber-token',expires_in:3600});if(String(url).endsWith(':pull'))return Response.json({receivedMessages:[{ackId:'ack-one',message:{data:Buffer.from(json({emailAddress:'owner@example.test',historyId:'101'})).toString('base64')}}]});return Response.json({});});
  await push.once(new AbortController().signal);expect(sync).toHaveBeenCalledWith('101',expect.any(AbortSignal));expect(fetch.mock.calls.some(call=>String(call[0]).endsWith(':acknowledge'))).toBe(false);
  sync.mockResolvedValue(true);await push.once(new AbortController().signal);expect(JSON.parse(fetch.mock.calls.find(call=>String(call[0]).endsWith(':acknowledge'))![1]!.body as string)).toEqual({ackIds:['ack-one']});expect(fixture.values.get('watch')).toMatchObject({historyId:'100'});
});
it('ignores foreign/invalid push hints without downloading mailbox content and renews expired watches',async()=>{
  const fixture=pushFixture();fixture.values.set('watch',{historyId:'old',expiration:'1'});const renew=vi.spyOn(fixture.account,'request'),sync=vi.fn();
  const push=new GmailPush(fixture.api,fixture.account,{topic:'projects/synthetic-project/topics/mail-events',subscription:'projects/synthetic-project/subscriptions/mail-events'},'owner@example.test',sync);
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).endsWith(':pull')?Response.json({receivedMessages:[{ackId:'foreign',message:{data:Buffer.from(json({emailAddress:'foreign@example.test',historyId:'101'})).toString('base64')}},{ackId:'malformed',message:{data:'e30='}}]}):Response.json(String(url)==='https://oauth2.googleapis.com/token'?{access_token:'subscriber-token',expires_in:3600}:{}));
  await push.once(new AbortController().signal);expect(renew).toHaveBeenCalledTimes(1);expect(sync).not.toHaveBeenCalled();
});
it.each([{label:'positive',text:'Booking changed',notify:true},{label:'ordering',text:'Change required before booking',notify:false},{label:'long no-change',text:'booking '.repeat(12_000),notify:false}])('matches ordered booking-change notifications in bounded passes ($label)',async({text,notify})=>{
  const s=instance(),message=normalizeMail({id:'synthetic-mail',threadId:'thread-one',internalDate:'1000',payload:{mimeType:'text/plain',headers:[{name:'From',value:'sender@example.test'}],body:{data:Buffer.from(text).toString('base64url')}}}),sync=new MailSync(s.store,{search:async()=>[],read:async()=>message,changes:async()=>({ids:[message.id],deleted:[],cursor:'101',baseline:false})},s.runtime.scheduler,'fixture');s.store.run("INSERT INTO mailbox VALUES('fixture','100',1,NULL)");sync.rule({bookingChange:true,priority:'immediate',cooldownMinutes:1});await sync.sync();expect(s.store.all('SELECT * FROM outbox')).toHaveLength(notify?1:0);
});
it('extracts bounded visible mail text without quadratic handling of unclosed tags or oversized headers',()=>{
  const message=(html:string,subject='Synthetic')=>normalizeMail({id:'mail-one',threadId:'thread-one',internalDate:'1000',payload:{mimeType:'text/html',headers:[{name:'Subject',value:subject}],body:{data:Buffer.from(html).toString('base64url')}}});
  expect(message('<p>Hello &amp; world</p><!-- hidden --><script>invisible</script><style>invisible</style>').text.trim()).toBe('Hello & world');expect(message(`Before<script>${'hidden<script>'.repeat(10_000)}SECRET_SHOULD_NOT_APPEAR`).text.trim()).toBe('Before');expect(message('x'.repeat(210_000),'y'.repeat(5000))).toMatchObject({truncated:true,subject:'y'.repeat(4000),text:'x'.repeat(100_000)});
});
it('bounds MIME headers and text encoding while preserving Unicode and binary attachments',()=>{
  const bytes=Buffer.from([0,1,255]);const mime=emailMime({from:'owner@example.test',to:['safe@example.test'],subject:'☕'.repeat(100),text:'Caffè\nSecond line',references:Array.from({length:20},(_,i)=>`<${'a'.repeat(100)}${i}@example.test>`).join(' ')},{id:id(),createdAt:0},[{metadata:{hash:hash(bytes),bytes:3,name:'report\r\nInjected.txt',mime:'bad\r\nInjected'},bytes}]);
  expect(mime).toContain('Content-Type: application/octet-stream');expect(mime).not.toContain('\r\nInjected.txt');expect(mime).toContain('AAH/');expect(mime).toContain('=?UTF-8?B?');expect(mime.split('\r\n').every(line=>line.length<998)).toBe(true);
});
