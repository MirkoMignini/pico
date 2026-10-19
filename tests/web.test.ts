import { afterEach, expect, it, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.js';
import { Store, hash, json } from '../src/store.js';
import { backup, restore, exportData } from '../src/backup.js';
import { rpc } from '../src/daemon.js';
import { atomicWrite, loadConfig } from '../src/config.js';
import { duckduckgoResults, braveResults, webArticle } from '../src/web-extract.js';
import type { Envelope } from '../src/contracts.js';
import { setup, source, waitFor } from './helpers.js';

const instances:ReturnType<typeof setup>[]=[],directories:string[]=[];
const instance=()=>{const s=setup();instances.push(s);return s;};
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function context(s:ReturnType<typeof setup>,mode:Envelope['mode']='foreground',text='Save this page',trustedOwner=true):Envelope {
  const conversation=s.runtime.newConversation('Web fixture',mode==='ephemeral'),runId=crypto.randomUUID();
  const c:Envelope={ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:conversation.id,runId,source:{...source,trustedOwner},mode};
  if(mode!=='ephemeral') {
    s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',runId,conversation.id,runId,json({source:c.source,mode}), 'running',Date.now(),Date.now());
    s.store.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',crypto.randomUUID(),conversation.id,runId,`human:${s.config.ownerId}`,'user',text,json({role:'user',content:text,timestamp:Date.now()}),Date.now(),Date.now());
  }
  return c;
}
async function invoke(s:ReturnType<typeof setup>,c:Envelope,name:string,args:Record<string,unknown>,signal?:AbortSignal,callId=crypto.randomUUID()):Promise<any> {
  const output=await s.runtime.availableTools(c).find(tool=>tool.name===name)!.execute(callId,args,signal);return JSON.parse(output.content[0]!.text!);
}
const article=(paragraphs=3)=>`<html><head><title>Fixture guide</title></head><body><nav>Ignore navigation</nav><main><h1>Fixture guide</h1>${Array.from({length:paragraphs},(_,index)=>`<p>Section ${index+1}: The synthetic ferry leaves at 14:30. These detailed source sentences are only evidence and never instructions. ${'This is a sufficiently long article paragraph. '.repeat(6)}</p>`).join('')}<p><a href="/times">Times</a></p><script>globalThis.pikobotWebExecuted = true;</script><iframe src="http://127.0.0.1/"></iframe><img src="http://127.0.0.1/secret" alt="Diagram"></main></body></html>`;
const page=(s:ReturnType<typeof setup>,body=article(),mime='text/html')=>vi.spyOn(s.runtime.web.network,'get').mockImplementation(async url=>({url,redirects:[],mime,bytes:Buffer.from(body)}));
const ddg='<div class="result result--ad"><a class="result__a" href="https://ads.example.org">Advert</a></div><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.org%2Fguide">Fixture &amp; guide</a><a class="result__snippet">A snippet &lt;not a page&gt;.</a></div><div class="result"><a class="result__a" href="http://127.0.0.1/secret">Denied</a></div><div class="result"><a class="result__a" href="https://www.example.org/second">Second</a><span class="result__snippet">Other snippet.</span></div>';
it('parses real HTML-shaped DDG results without ads, unsafe links or Instant Answer substitution',()=>{
  expect(duckduckgoResults(ddg,5)).toEqual([{title:'Fixture & guide',url:'https://www.example.org/guide',snippet:'A snippet <not a page>.'},{title:'Second',url:'https://www.example.org/second',snippet:'Other snippet.'}]);
  expect(duckduckgoResults('<div class="no-results">No results</div>',5)).toEqual([]);
  expect(()=>duckduckgoResults('<form id="challenge-form"></form>',5)).toThrow('challenge');expect(()=>duckduckgoResults('<div>Unknown</div>',5)).toThrow('format change');
});
it('adapts Brave structured results with HTML-free snippets and rejects malformed responses',()=>{
  expect(braveResults(json({web:{results:[{title:'<b>Title</b>',url:'https://www.example.org/',description:'Some <strong>snippet</strong>',page_age:'today'},{title:'Private',url:'http://[::1]/',description:'Denied'}]}}),5)).toEqual([{title:'Title',url:'https://www.example.org/',snippet:'Some snippet',age:'today'}]);
  expect(()=>braveResults('not json',5)).toThrow('Invalid Brave');expect(()=>braveResults('{}',5)).toThrow('Invalid Brave');
});
it('reuses Readability/Markdown extraction with no executable content or unsafe resource links',()=>{
  const result=webArticle(article(),'https://www.example.org/guide','text/html');
  expect(result).toMatchObject({title:'Fixture guide',extraction:'readability',truncated:false});expect(result.text).toContain('14:30');expect(result.text).toContain('https://www.example.org/times');
  expect(result.text).not.toContain('pikobotWebExecuted');expect(result.text).not.toContain('127.0.0.1');expect((globalThis as any).pikobotWebExecuted).toBeUndefined();
  vi.spyOn(Readability.prototype,'parse').mockReturnValueOnce(null);
  expect(webArticle('<html><title>Fallback</title><main>Brief but usable text.</main></html>','https://www.example.org/','text/html').warnings).toContain('Fallback extraction may include navigation or omit content.');
  expect(()=>webArticle('', 'https://www.example.org/','text/plain')).toThrow('No readable');expect(()=>webArticle('opaque','https://www.example.org/','application/pdf')).toThrow('Unsupported web');
  expect(webArticle(Buffer.from('<title>Café</title><p>Un café français.</p>','latin1'),'https://www.example.org/','text/html','text/html; charset=windows-1252').text).toContain('café');
  expect(webArticle(Buffer.from('Café','latin1'),'https://www.example.org/','text/plain','text/plain; charset=windows-1252').text).toBe('Café');
  expect(()=>webArticle(Buffer.from([0xff]),'https://www.example.org/','text/plain')).toThrow('encoding');
  expect(webArticle('a'.repeat(90_000),'https://www.example.org/','text/plain')).toMatchObject({truncated:true,text:'a'.repeat(80_000)});
});
it('defaults old/new instances to DDG, captures labelled search evidence, and never fetches result pages',async()=>{
  const s=instance(),c=context(s),network=page(s,ddg);
  const result=await invoke(s,c,'web_search',{query:'synthetic ferry'});
  expect(result).toMatchObject({provider:'duckduckgo',snippetOnly:true,sourceActor:'external:web',results:[{url:'https://www.example.org/guide',snippetOnly:true},{url:'https://www.example.org/second',snippetOnly:true}]});
  expect(network).toHaveBeenCalledTimes(1);expect(network.mock.calls[0]![0]).toBe('https://html.duckduckgo.com/html/?q=synthetic+ferry');
  expect(s.runtime.memory.source(result.sourceId)).toMatchObject({actor:'external:web',web:{provider:'duckduckgo'}});
  expect(s.store.all('SELECT * FROM memories')).toEqual([]);expect(s.runtime.knowledge.list().total).toBe(0);expect(s.store.all('SELECT * FROM retrieval WHERE source_id=?',result.sourceId)).toEqual([]);
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',c.runId)).toContainEqual({source_id:result.sourceId});
  await expect(invoke(s,c,'web_save',{id:result.sourceId})).rejects.toThrow('not search snippets');
});
it('uses Brave only when explicitly configured with this vault secret, never environment or implicit fallback',async()=>{
  const s=instance(),c=context(s),network=page(s,json({web:{results:[{title:'Fixture',url:'https://www.example.org/',description:'Synthetic snippet'}]}}),'application/json');
  s.config.search={provider:'brave'};vi.stubEnv('BRAVE_API_KEY','forbidden-environment-key');
  await expect(invoke(s,c,'web_search',{query:'fixture'})).rejects.toThrow('masked');expect(network).not.toHaveBeenCalled();
  await rpc(s.runtime,{op:'secret.set',args:{name:'brave.searchKey',value:'synthetic-private-key'}});
  const result=await invoke(s,c,'web_search',{query:'fixture',limit:1});expect(result.provider).toBe('brave');expect(network.mock.calls[0]).toEqual([expect.stringContaining('https://api.search.brave.com/res/v1/web/search?'),expect.any(AbortSignal),{braveKey:'synthetic-private-key'}]);
  expect(json(s.store.all('SELECT * FROM messages'))).not.toContain('synthetic-private-key');expect(json(s.store.all('SELECT * FROM operations'))).not.toContain('synthetic-private-key');
  expect(json(exportData(s.store))).not.toContain('synthetic-private-key');expect((await rpc(s.runtime,{op:'secret.status'}) as any)['brave.searchKey']).toBe(true);
});
it('fails provider challenges without retaining fake results or invoking Brave',async()=>{
  const s=instance(),c=context(s),network=page(s,'<form id="challenge-form"></form>');await s.runtime.credentials.setSecret('brave.searchKey','synthetic-key');
  await expect(invoke(s,c,'web_search',{query:'fixture'})).rejects.toThrow('challenge');expect(network).toHaveBeenCalledTimes(1);expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);
});
it('never retains or exposes an API credential reflected by the search provider',async()=>{
  const s=instance(),c=context(s);s.config.search={provider:'brave'};await s.runtime.credentials.setSecret('brave.searchKey','synthetic-secret-brave');
  page(s,json({web:{results:[{title:'synthetic-secret-brave',url:'https://www.example.org/',description:'Fixture'}]}}),'application/json');
  await expect(invoke(s,c,'web_search',{query:'fixture'})).rejects.toThrow('reflected credentials');expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);expect(json(s.store.all('SELECT * FROM operations'))).not.toContain('synthetic-secret-brave');
});

it('reads/paginates immutable web snapshots with actual lineage and verified citations across reconstruction',async()=>{
  const s=instance(),c=context(s),network=page(s,article(100)),first=await invoke(s,c,'web_fetch',{url:'https://www.example.org/guide'});
  expect(first).toMatchObject({kind:'page',extraction:'readability',sourceActor:'external:web',fromLine:1});expect(first.nextLine).not.toBeNull();expect(first.text.length).toBeLessThanOrEqual(10_000);
  const next=await invoke(s,c,'web_read',{id:first.sourceId,fromLine:first.nextLine,maxLines:3});expect(next.fromLine).toBe(first.nextLine);expect(network).toHaveBeenCalledTimes(1);
  expect(()=>s.runtime.web.resolve(first.citation,c)).not.toThrow();expect(()=>s.runtime.web.resolve(first.citation.replace(/:[a-f0-9]{64}:/,`:${'0'.repeat(64)}:`),c)).toThrow();expect(()=>s.runtime.web.resolve(first.citation.replace(/:L\d+-\d+$/,':L1-999999'),c)).toThrow();
  const user=s.store.get<any>("SELECT id FROM messages WHERE run_id=? AND role='user'",c.runId);expect(s.store.all('SELECT * FROM web_source_dependencies')).toContainEqual({web_id:first.sourceId,source_id:user.id});
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);expect(await invoke(s,c,'web_read',{id:first.sourceId,maxLines:2})).toMatchObject({sourceId:first.sourceId});
  s.store.run('UPDATE web_sources SET text=? WHERE id=?','Tampered',first.sourceId);await expect(invoke(s,c,'web_read',{id:first.sourceId})).rejects.toThrow('integrity');
});
it('saves useful pages without explicit save wording while preserving external provenance and mode guards',async()=>{
  const s=instance(),c=context(s,'foreground','This guide may help later'),network=page(s),fetched=await invoke(s,c,'web_fetch',{url:'https://www.example.org/guide'});
  const saved=await invoke(s,c,'web_save',{id:fetched.sourceId,title:'Saved web evidence'}),record=s.runtime.knowledge.read(saved.id);
  expect(saved).toMatchObject({saved:true,sourceActor:'external:web',origin:fetched.sourceId});expect(record.text).toContain('URL: https://www.example.org/guide');
  expect(s.runtime.memory.source(saved.sourceId)).toMatchObject({actor:'external:web'});expect(record.conversion).toMatchObject({authoredBy:'external:web',dependencies:expect.arrayContaining([fetched.sourceId])});
  expect(s.store.all('SELECT * FROM memories')).toEqual([]);expect(network).toHaveBeenCalledTimes(1);
  const followup=context(s,'foreground','What does this page say?'),another=await invoke(s,followup,'web_save',{id:fetched.sourceId});
  expect(s.runtime.memory.source(another.sourceId)?.actor).toBe('external:web');
  for(const c of [context(s,'ephemeral'),context(s,'scheduled'),context(s,'review'),context(s,'foreground','Save page',false)])await expect(invoke(s,c,'web_save',{id:fetched.sourceId})).rejects.toThrow();
  expect(s.runtime.knowledge.list().total).toBe(2);
});
it('keeps ephemeral browsing volatile, denies cross-session retention and clears it on restart',async()=>{
  const s=instance(),c=context(s,'ephemeral'),network=page(s,'volatile-web-sentinel','text/plain'),fetched=await invoke(s,c,'web_fetch',{url:'https://www.example.org/private-query'});
  expect((await invoke(s,c,'source_read',{id:fetched.sourceId})).text).toBe('volatile-web-sentinel');
  for(const table of ['web_sources','web_source_dependencies','operations','messages','memories','documents'])expect(s.store.all(`SELECT * FROM ${table}`)).toEqual([]);
  expect(()=>s.runtime.web.resolve(fetched.citation,context(s,'ephemeral'))).toThrow('not retained');
  await expect(invoke(s,context(s), 'web_save',{id:fetched.sourceId})).rejects.toThrow('not retained');
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);expect(()=>s.runtime.web.resolve(fetched.citation,c)).toThrow('not retained');expect(network).toHaveBeenCalledTimes(1);
});
it('validates schemas and ownership before any external request, and shares the per-run call budget',async()=>{
  const s=instance(),c=context(s),network=page(s),fetched=await invoke(s,c,'web_fetch',{url:'https://www.example.org/'});
  for(const args of [{url:'https://www.example.org/',ownerId:'foreign'},{url:'file:///etc/passwd'},{url:'http://127.0.0.1/'}])await expect(invoke(s,c,'web_fetch',args)).rejects.toThrow();
  await expect(invoke(s,{...c,ownerId:'foreign'},'web_fetch',{url:'https://www.example.org/'})).rejects.toThrow('ownership');
  // Each extension tool plus its core service call consumes the same per-run budget.
  let reads=0,exhausted='';
  try { for(let n=0;n<80;n++){await invoke(s,c,'web_read',{id:fetched.sourceId,maxLines:1});reads++;} } catch(error) { exhausted=(error as Error).message; }
  expect(exhausted).toContain('budget exhausted');expect(reads).toBeGreaterThanOrEqual(13);expect(network).toHaveBeenCalledTimes(1);
});
it('forgets browsing sources/copies, saved derivatives, schedules and old backups without resurrection',async()=>{
  const s=instance(),c=context(s);page(s);const first=await invoke(s,c,'web_fetch',{url:'https://www.example.org/guide'}),second=await invoke(s,c,'web_fetch',{url:'https://www.example.org/guide'}),saved=await invoke(s,c,'web_save',{id:first.sourceId});
  const scheduled=s.runtime.scheduler.create({text:'Derived web reminder',timezone:'UTC',at:new Date(Date.now()+60_000).toISOString(),kind:'reminder',destination:'terminal',misfire:'once'},'Synthetic');s.store.run('INSERT INTO schedule_sources VALUES(?,?)',scheduled.id,first.sourceId);
  const snap=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pikobot-web-backup-'));directories.push(external);cpSync(snap.path,external,{recursive:true});
  await rpc(s.runtime,{op:'web.forget',args:{id:first.sourceId}});expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);expect(s.runtime.scheduler.list()).toEqual([]);expect(()=>s.runtime.knowledge.document(saved.id)).toThrow('not found');expect(()=>s.runtime.web.resolve(second.citation,c)).toThrow();
  const fresh=context(s);await expect(invoke(s,fresh,'web_fetch',{url:'https://www.example.org/guide'})).rejects.toThrow('forgotten');
  await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);directories.push(s.root);await restore(s.root,external,true);
  const restored=new Store(s.root,s.config);try{expect(restored.all('SELECT * FROM web_sources')).toEqual([]);expect(restored.all('PRAGMA foreign_key_check')).toEqual([]);expect(restored.get('SELECT deleted_at FROM documents WHERE id=?',saved.id)).toMatchObject({deleted_at:expect.any(Number)});}finally{restored.close();}
});
it('invalidates late downloads during forgetting and never republishes erased context',async()=>{
  const s=instance(),c=context(s);page(s);const fetched=await invoke(s,c,'web_fetch',{url:'https://www.example.org/first'});let release!:(value:any)=>void;
  vi.spyOn(s.runtime.web.network,'get').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const pending=invoke(s,c,'web_fetch',{url:'https://www.example.org/second'});const failure=expect(pending).rejects.toThrow('invalidated');await waitFor(()=>!!release);await rpc(s.runtime,{op:'web.forget',args:{id:fetched.sourceId}});release({url:'https://www.example.org/second',redirects:[],mime:'text/html',bytes:Buffer.from(article())});await failure;expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);
});
it('forgets web captures and derivatives when the original owner evidence is forgotten',async()=>{
  const s=instance(),c=context(s);page(s);const fetched=await invoke(s,c,'web_fetch',{url:'https://www.example.org/guide'}),saved=await invoke(s,c,'web_save',{id:fetched.sourceId});
  const user=s.store.get<any>("SELECT id,text FROM messages WHERE run_id=? AND role='user'",c.runId);
  const memory=s.runtime.memory.remember({sourceId:user.id,entity:`owner:${s.config.ownerId}`,kind:'fact',key:'synthetic-web-request',value:user.text,quote:user.text,eventAt:Date.now()},false);
  await s.runtime.forget(memory.id);expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);expect(()=>s.runtime.knowledge.document(saved.id)).toThrow('not found');
});

it('forgetting a saved web knowledge page also erases its underlying browsing snapshots',async()=>{
  const s=instance(),c=context(s);page(s);const fetched=await invoke(s,c,'web_fetch',{url:'https://www.example.org/guide'}),saved=await invoke(s,c,'web_save',{id:fetched.sourceId});
  await s.runtime.deleteKnowledge(saved.id,true);expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);expect(()=>s.runtime.web.resolve(fetched.citation,c)).toThrow();
});

it('aborts a direct web operation on shutdown without publishing a late snapshot',async()=>{
  const s=instance(),c=context(s);let started=false,aborted=false;
  vi.spyOn(s.runtime.web.network,'get').mockImplementation((_url,signal)=>new Promise((_resolve,reject)=>{started=true;signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('Shutdown fixture'));},{once:true});}));
  const operation=invoke(s,c,'web_fetch',{url:'https://www.example.org/'}),failure=expect(operation).rejects.toThrow();await waitFor(()=>started);await s.runtime.close();await failure;expect(aborted).toBe(true);expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);
});

it('upgrades a real schema-nine fixture without losing owner memories/tags and preserves search settings strictly',async()=>{
  const s=instance(),record=s.runtime.remember('synthetic','preserved','global','fact',undefined,['tests']) as any;await s.runtime.close();s.store.db.exec('DROP TABLE web_source_dependencies;DROP TABLE web_sources;ALTER TABLE run_sources DROP COLUMN inherited;PRAGMA user_version=9');s.store.close();s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);
  expect(s.store.get<any>('PRAGMA user_version').user_version).toBe(15);expect(s.runtime.memory.read(record.id).memory.tags).toEqual(['tests']);expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);
  atomicWrite(join(s.root,'config.json'),json(s.config));await rpc(s.runtime,{op:'settings.update',args:{search:{provider:'brave'}}});expect(loadConfig(s.root).config.search).toEqual({provider:'brave'});
  for(const search of [{provider:'unsupported'},{provider:'brave',key:'must-not-go-here'},{provider:'duckduckgo',endpoint:'http://localhost'}])await expect(rpc(s.runtime,{op:'settings.update',args:{search}})).rejects.toThrow('Invalid input');
  await rpc(s.runtime,{op:'settings.update',args:{search:null}});expect(loadConfig(s.root).config.search).toBeUndefined();
});
