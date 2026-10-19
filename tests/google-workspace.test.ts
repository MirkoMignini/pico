import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rpc } from '../src/daemon.js';
import { Runtime } from '../src/runtime.js';
import { Store, hash, id, json } from '../src/store.js';
import { backup, restore } from '../src/backup.js';
import type { Envelope } from '../src/contracts.js';
import { defaultSettings, googleScopes, type GoogleSettings, SCOPES } from '../src/features/google/settings.js';
import { sheetRange } from '../src/features/google/sheets.js';
import type { RemoteAction } from '../src/features/integrations/contracts.js';
import { setup, source } from './helpers.js';

const instances:ReturnType<typeof setup>[]=[],directories:string[]=[];
async function instance(change:(settings:GoogleSettings)=>void=()=>{}){
  const s=setup();instances.push(s);const settings=defaultSettings('synthetic-client');settings.mail.enabled=false;
  settings.contacts={enabled:true};settings.drive={enabled:true};settings.sheets={enabled:true,write:false};settings.tasks={enabled:true,write:false};change(settings);
  await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings}});
  s.store.run('INSERT INTO extension_storage(extension_id,key,value) VALUES(?,?,?)','google','identity',json({sub:'synthetic-account',email:'owner@example.test',email_verified:true,epoch:'synthetic-epoch'}));
  await s.runtime.credentials.modify('gmail',async()=>({type:'oauth',access:'synthetic-token',refresh:'synthetic-refresh',expires:Date.now()+3600_000,scopes:googleScopes(settings)}));
  return Object.assign(s,{settings});
}
const owner=(s:ReturnType<typeof setup>):Envelope=>({ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:'',runId:id(),source,mode:'foreground'});
const invoke=async(s:ReturnType<typeof setup>,tool:string,args:unknown)=>{const result=await s.runtime.invokeExtension(tool,args,owner(s));return JSON.parse((result.content[0] as {text:string}).text);};
const approve=(s:ReturnType<typeof setup>,action:RemoteAction,decision=true)=>rpc(s.runtime,{op:'extensions.google.actions.approve',args:{id:action.id,digest:action.digest,decision}});
afterEach(async()=>{vi.restoreAllMocks();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});

it('keeps legacy settings valid and new capabilities disabled until explicit setup/consent',async()=>{
  const s=await instance(settings=>{delete settings.contacts;delete settings.drive;delete settings.sheets;delete settings.tasks;});
  const manifest=await rpc(s.runtime,{op:'extensions.setup',args:{id:'google'}}) as any,status=await rpc(s.runtime,{op:'extensions.google.status'}) as any;
  expect(manifest.settings).toMatchObject({contacts:{enabled:false},drive:{enabled:false},sheets:{enabled:false,write:false},tasks:{enabled:false,write:false}});
  expect(status.capabilities).toMatchObject({contacts:false,drive:false,sheets:false,sheetsWrite:false,tasks:false,tasksWrite:false});
  expect(JSON.parse(s.store.get<{value:string}>("SELECT value FROM extension_storage WHERE extension_id='google' AND key='settings'")!.value).contacts).toBeUndefined();
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
  for(const [tool,args]of [['google_contacts',{action:'list'}],['google_drive',{action:'search',query:''}],['google_sheets',{action:'read',spreadsheetId:'sheet'}],['google_tasks',{action:'lists'}]] as const)await expect(invoke(s,tool,args)).rejects.toThrow('disabled');
  expect(fetch).not.toHaveBeenCalled();expect(googleScopes(s.settings)).not.toContain(SCOPES.driveRead);
});
it('requests only selected read scopes, reuses broader grants for reads and requires separate write consent',async()=>{
  const s=await instance(settings=>{settings.docs.enabled=true;settings.docs.discovery=true;});
  const scopes=googleScopes(s.settings);expect(scopes).toEqual(expect.arrayContaining([SCOPES.contactsRead,SCOPES.driveRead,SCOPES.sheetsRead,SCOPES.tasksRead]));expect(scopes).not.toContain(SCOPES.driveMetadata);expect(scopes).not.toContain(SCOPES.sheetsWrite);expect(scopes).not.toContain(SCOPES.tasksWrite);
  s.settings.sheets!.write=true;s.settings.tasks!.write=true;await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings:s.settings}});
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
  await expect(invoke(s,'google_tasks',{action:'create',taskListId:'@default',title:'Test'})).rejects.toThrow('consent');
  await expect(invoke(s,'google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1',values:[[1]]})).rejects.toThrow('consent');expect(fetch).not.toHaveBeenCalled();
});
it('keeps Sheets/Tasks reads working with existing broader grants after writes are disabled',async()=>{
  const s=await instance(settings=>{settings.sheets!.write=true;settings.tasks!.write=true;});
  s.settings.sheets!.write=false;s.settings.tasks!.write=false;await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings:s.settings}});
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).includes('sheets.googleapis.com')?Response.json({spreadsheetId:'sheet',properties:{title:'Synthetic'}}):Response.json({items:[]}));
  expect((await rpc(s.runtime,{op:'extensions.google.status'}) as any).consentRequired).toEqual([]);
  expect(await invoke(s,'google_sheets',{action:'read',spreadsheetId:'sheet'})).toMatchObject({spreadsheetId:'sheet'});expect(await invoke(s,'google_tasks',{action:'lists'})).toMatchObject({items:[]});
});
it('reads Contacts with paginated field-limited lists, exact identities and bounded prefix-search warmup',async()=>{
  const s=await instance(),person={resourceName:'people/c123',names:[{displayName:'Synthetic Person'}],emailAddresses:[{value:'person@example.test'}]};
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{expect(options?.redirect).toBe('error');const u=new URL(String(url));if(u.pathname.endsWith(':searchContacts')){expect(u.searchParams.get('readMask')).toBe('names,emailAddresses,phoneNumbers,organizations');return Response.json({results:u.searchParams.get('query')?[{person}]:[]});}if(u.pathname.endsWith('/connections'))return Response.json({connections:[person],nextPageToken:'next',totalPeople:2});return Response.json(person);});
  expect(await invoke(s,'google_contacts',{action:'list',pageToken:'page-two',limit:1})).toMatchObject({people:[person],nextPageToken:'next',totalPeople:2});expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get('pageToken')).toBe('page-two');
  expect(await invoke(s,'google_contacts',{action:'search',query:'Synthetic',limit:2})).toMatchObject({results:[{person}],complete:false});
  expect(fetch.mock.calls.slice(1,3).map(([url])=>new URL(String(url)).searchParams.get('query'))).toEqual(['','Synthetic']);
  expect(await invoke(s,'google_contacts',{action:'read',resourceName:'people/c123'})).toMatchObject({person});
  fetch.mockResolvedValue(Response.json({...person,resourceName:'people/wrong'}));await expect(invoke(s,'google_contacts',{action:'read',resourceName:'people/c123'})).rejects.toThrow('identity mismatch');
  expect(s.store.all('SELECT * FROM memories')).toEqual([]);
});
it('searches Drive by folder/type/ownership/creation date and preserves shared-drive cursors',async()=>{
  const s=await instance(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({files:[{id:'file',name:'Synthetic'}],nextPageToken:'next',incompleteSearch:true}));
  expect(await invoke(s,'google_drive',{action:'search',query:"O'Brien\\file",folderId:'folder',driveId:'shared',mimeType:'application/pdf',ownedByMe:true,orderBy:'createdTime desc',pageToken:'page-two',limit:2})).toMatchObject({files:[{id:'file'}],nextPageToken:'next',incompleteSearch:true});
  const url=new URL(String(fetch.mock.calls[0]![0]));expect(url.searchParams.get('q')).toContain("name contains 'O\\'Brien\\\\file'");expect(url.searchParams.get('q')).toContain("'folder' in parents");expect(url.searchParams.get('q')).toContain("'me' in owners");expect(url.searchParams.get('orderBy')).toBe('createdTime desc');expect(url.searchParams.get('fields')).toContain('createdTime');expect(url.searchParams.get('corpora')).toBe('drive');expect(url.searchParams.get('driveId')).toBe('shared');expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');expect(url.searchParams.get('pageToken')).toBe('page-two');
  fetch.mockResolvedValue(Response.json({drives:[{id:'shared',name:'Shared'}],nextPageToken:'more'}));expect(await invoke(s,'google_drive',{action:'drives'})).toMatchObject({drives:[{id:'shared'}],nextPageToken:'more'});
});
it('resolves the Drive root alias without treating folders as downloadable files',async()=>{
  const s=await instance(),fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({id:'canonical-root',name:'My Drive',mimeType:'application/vnd.google-apps.folder',version:'1'}));
  expect(await invoke(s,'google_drive',{action:'read',fileId:'root'})).toMatchObject({file:{id:'canonical-root'}});await expect(invoke(s,'google_drive',{action:'import',fileId:'root'})).rejects.toThrow('not a folder');expect(fetch.mock.calls.every(([url])=>!String(url).includes('alt=media'))).toBe(true);
});
function driveFetch(options:{native?:boolean;change?:boolean;body?:Uint8Array;size?:string;blocked?:boolean}={}){
  let metadataReads=0;const bytes=options.body??Buffer.from('Synthetic Drive text');
  return vi.spyOn(globalThis,'fetch').mockImplementation(async(url,request)=>{
    expect(request?.redirect).toBe('error');const u=new URL(String(url));expect(u.origin).toBe('https://www.googleapis.com');
    if(u.searchParams.get('alt')==='media'||u.pathname.endsWith('/export'))return new Response(bytes);
    const id=u.pathname.split('/').at(-1)!;return Response.json({id,name:'Synthetic.txt',mimeType:options.native?'application/vnd.google-apps.document':'text/plain',version:options.change&&metadataReads++>0?'2':'1',...(options.size?{size:options.size}:{}),capabilities:{canDownload:!options.blocked},webContentLink:'http://127.0.0.1/never-follow'});
  });
}
it('imports a bounded Drive file through existing originals/processing without following metadata URLs or importing in bulk',async()=>{
  const s=await instance(),fetch=driveFetch(),args={action:'import',fileId:'file'};
  const saved=await invoke(s,'google_drive',args);expect(saved).toMatchObject({origin:'external:google-drive',sourceId:'google:drive:file',version:'1'});expect(s.runtime.knowledge.original(saved.documentId).bytes.toString()).toBe('Synthetic Drive text');expect(s.runtime.knowledge.document(saved.documentId).channel).toBe('integration');expect(s.store.all('SELECT status FROM document_jobs')).toEqual([{status:'pending'}]);
  expect(await invoke(s,'google_drive',args)).toMatchObject({documentId:saved.documentId,reused:true});expect(s.store.all('SELECT id FROM documents')).toHaveLength(1);expect(s.faux.state.callCount).toBe(0);expect(fetch.mock.calls.every(([url])=>String(url).startsWith('https://www.googleapis.com/drive/v3/'))).toBe(true);
});
it.each(['changed','oversize-metadata','oversize-body','blocked'])('refuses unsafe Drive imports before local persistence (%s)',async kind=>{
  const s=await instance();s.config.limits.attachmentBytes=8;
  driveFetch({body:Buffer.from(kind==='oversize-body'?'x'.repeat(9):'safe'),change:kind==='changed',size:kind==='oversize-metadata'?'9':undefined,blocked:kind==='blocked'});
  await expect(invoke(s,'google_drive',{action:'import',fileId:'file'})).rejects.toThrow();expect(s.store.all('SELECT * FROM attachments')).toEqual([]);expect(s.store.all('SELECT * FROM documents')).toEqual([]);
});
it('refuses a Drive result admitted before source erasure instead of publishing late files',async()=>{
  const s=await instance(),fact=s.runtime.remember('Synthetic source','Erase this synthetic source'),fetch=driveFetch(),original=fetch.getMockImplementation()!;
  fetch.mockImplementation(async(url,options)=>{const response=await original(url,options);if(new URL(String(url)).searchParams.get('alt')==='media')await s.runtime.forget(fact.id);return response;});
  await expect(invoke(s,'google_drive',{action:'import',fileId:'file'})).rejects.toThrow('invalidated by erasure');expect(s.store.all('SELECT * FROM attachments')).toEqual([]);expect(s.store.all('SELECT * FROM documents')).toEqual([]);
});
it('tombstones forgotten integration files across a pre-import backup and changed remote versions',async()=>{
  const s=await instance(),snapshot=await backup(s.store),path=mkdtempSync(join(tmpdir(),'pikobot-drive-restore-'));directories.push(path);cpSync(snapshot.path,path,{recursive:true});const fetch=driveFetch();
  const saved=await invoke(s,'google_drive',{action:'import',fileId:'file'});await s.runtime.deleteKnowledge(saved.documentId,true);expect(s.store.get('SELECT hash FROM deletions WHERE hash=?',hash('source:google:drive:file'))).toBeDefined();
  await s.runtime.close();s.store.close();await restore(s.root,path,true);const store=new Store(s.root,s.config),runtime=new Runtime(store,s.runtime.models);s.store=store;s.runtime=runtime;
  fetch.mockImplementation(async url=>new URL(String(url)).searchParams.get('alt')==='media'?new Response('Changed remote bytes'):Response.json({id:'file',name:'Changed.txt',mimeType:'text/plain',version:'2'}));
  fetch.mockClear();await expect(invoke(s,'google_drive',{action:'import',fileId:'file'})).rejects.toThrow('forgotten');expect(fetch).not.toHaveBeenCalled();expect(store.all('SELECT * FROM attachments')).toEqual([]);
});
it('uses the same stable Google Doc source for Drive exports and direct Docs snapshots',async()=>{
  const s=await instance(settings=>{settings.docs.enabled=true;settings.docs.readAll=true;});const fetch=driveFetch({native:true});
  const saved=await invoke(s,'google_drive',{action:'import',fileId:'file',format:'txt'});expect(saved.sourceId).toBe('google:doc:file');await s.runtime.deleteKnowledge(saved.documentId,true);
  fetch.mockResolvedValue(Response.json({documentId:'file',title:'Synthetic',body:{content:[]}}));await expect(invoke(s,'google_docs',{action:'import',documentId:'file'})).rejects.toThrow('reimport denied');
});
it.each(['A:A','Sheet1!A0','Sheet1!A2:A1','Sheet1!A1:ZZ100','Sheet1!A1000001','Sheet1!A1:B2\n'])('requires bounded explicit spreadsheet rectangles (%s)',range=>{expect(()=>sheetRange(range)).toThrow();});
it('supports quoted tab names and unambiguously bounds single-cell reads',()=>{expect(sheetRange("'Bob''s sheet'!A1:B2")).toMatchObject({sheet:"Bob's sheet",rows:2,columns:2});expect(sheetRange('Sheet1!A1')).toMatchObject({rows:1,columns:1});});
function sheetsFetch(){
  let cells:(string|number|boolean)[][]=[[1,'=SUM(A1)']];
  const put=vi.fn();const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
    const u=new URL(String(url));expect(u.origin).toBe('https://sheets.googleapis.com');expect(options?.redirect).toBe('error');
    if(options?.method==='PUT'){put(options);return Response.json({spreadsheetId:'sheet',updatedRange:'Sheet1!A1:B1',updatedCells:2});}
    if(u.pathname.includes('/values/'))return Response.json({range:'Sheet1!A1:B1',values:cells});
    return Response.json({spreadsheetId:'sheet',properties:{title:'Synthetic budget'},sheets:[{properties:{sheetId:0,title:'Sheet1'}}]});
  });return {fetch,put,change:()=>{cells=[[99,'changed']];}};
}
it('reads Sheets metadata and complete bounded ranges without implying complete spreadsheet coverage',async()=>{
  const s=await instance(),fixture=sheetsFetch();expect(await invoke(s,'google_sheets',{action:'read',spreadsheetId:'sheet'})).toMatchObject({spreadsheetId:'sheet',properties:{title:'Synthetic budget'}});
  expect(await invoke(s,'google_sheets',{action:'values',spreadsheetId:'sheet',range:'Sheet1!A1:B1',render:'FORMULA'})).toMatchObject({values:[[1,'=SUM(A1)']],completeRange:true});expect(fixture.put).not.toHaveBeenCalled();
});
it('prepares exact before/after cells, writes literals only after approval and never replays an accepted update',async()=>{
  const s=await instance(settings=>{settings.sheets!.write=true;}),fixture=sheetsFetch();
  const {action}=await invoke(s,'google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1:B1',values:[[2,'=IMPORTXML("https://example.test")']]});
  expect(action.payload).toMatchObject({before:[[1,'=SUM(A1)']],values:[[2,expect.any(String)]],inputMode:'RAW'});expect(fixture.put).not.toHaveBeenCalled();
  expect(await approve(s,action)).toMatchObject({status:'accepted'});expect(fixture.put).toHaveBeenCalledTimes(1);const call=fixture.fetch.mock.calls.find(([,options])=>options?.method==='PUT')!;expect(new URL(String(call[0])).searchParams.get('valueInputOption')).toBe('RAW');expect(JSON.parse(call[1]!.body as string).values).toEqual([[2,'=IMPORTXML("https://example.test")']]);
  await expect(approve(s,action)).rejects.toThrow('consumed');expect(fixture.put).toHaveBeenCalledTimes(1);
});
it('rejects changed sheet cells and malformed update shapes without sending an update',async()=>{
  const s=await instance(settings=>{settings.sheets!.write=true;}),fixture=sheetsFetch();
  await expect(invoke(s,'google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1:B1',values:[[1]]})).rejects.toThrow('exactly fill');expect(fixture.fetch).not.toHaveBeenCalled();
  const {action}=await invoke(s,'google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1:B1',values:[[2,3]]});fixture.change();expect(await approve(s,action)).toMatchObject({status:'rejected'});expect(fixture.put).not.toHaveBeenCalled();
});
it('invalidates a prepared sheet write when owner settings change, without another network request',async()=>{
  const s=await instance(settings=>{settings.sheets!.write=true;}),fixture=sheetsFetch(),{action}=await invoke(s,'google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1:B1',values:[[2,3]]});
  s.settings.sheets!.write=false;await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings:s.settings}});fixture.fetch.mockClear();await expect(approve(s,action)).rejects.toThrow('Connection or permissions changed');expect(fixture.fetch).not.toHaveBeenCalled();
});
it('treats a lost sheet acceptance as uncertain, not safe to resend',async()=>{
  const s=await instance(settings=>{settings.sheets!.write=true;}),fixture=sheetsFetch();const {action}=await invoke(s,'google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1:B1',values:[[2,3]]});
  const read=fixture.fetch.getMockImplementation()!;fixture.fetch.mockImplementation(async(url,options)=>{if(options?.method==='PUT')throw new Error('Synthetic lost acknowledgment');return read(url,options);});
  expect(await approve(s,action)).toMatchObject({status:'uncertain'});await expect(approve(s,action)).rejects.toThrow('consumed');expect(fixture.fetch.mock.calls.filter(([,options])=>options?.method==='PUT')).toHaveLength(1);
});
function tasksFetch(){
  let task:any={id:'task',etag:'"v1"',title:'Synthetic task',status:'needsAction'};const mutations=vi.fn();
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
    const u=new URL(String(url));expect(u.origin).toBe('https://tasks.googleapis.com');expect(options?.redirect).toBe('error');
    if(options?.method&&options.method!=='GET'){mutations(options);return options.method==='DELETE'?new Response(null,{status:204}):Response.json({...task,...JSON.parse(options.body as string),id:options.method==='POST'?'created-task':'task',etag:'"v2"'});}
    if(u.pathname.endsWith('/task'))return Response.json(task);
    return Response.json({items:u.pathname.endsWith('/users/@me/lists')?[{id:'list',title:'Work'}]:[task],nextPageToken:'next'});
  });return {fetch,mutations,change:()=>{task={...task,etag:'"changed"'};},assign:()=>{task={...task,assignmentInfo:{surfaceType:'DOCUMENT'}};}};
}
it('lists Google task lists/tasks with pagination, completion filters and date-only semantics',async()=>{
  const s=await instance(),fixture=tasksFetch();expect(await invoke(s,'google_tasks',{action:'lists',pageToken:'page-two'})).toMatchObject({items:[{id:'list'}],nextPageToken:'next'});
  expect(await invoke(s,'google_tasks',{action:'list',taskListId:'list',includeCompleted:true})).toMatchObject({items:[{id:'task'}],note:expect.stringContaining('dates')});const u=new URL(String(fixture.fetch.mock.calls[1]![0]));expect(u.searchParams.get('showCompleted')).toBe('true');expect(u.searchParams.get('showHidden')).toBe('true');expect(u.searchParams.get('showDeleted')).toBe('false');
  expect(await invoke(s,'google_tasks',{action:'read',taskListId:'list',taskId:'task'})).toMatchObject({task:{etag:'"v1"'}});expect(fixture.mutations).not.toHaveBeenCalled();
});
it('creates a date-only task once after exact approval, never a timed Pikobot reminder',async()=>{
  const s=await instance(settings=>{settings.tasks!.write=true;}),fixture=tasksFetch();const {action}=await invoke(s,'google_tasks',{action:'create',taskListId:'@default',title:'Synthetic',dueDate:'2099-10-15'});
  expect(action.payload.body).toEqual({title:'Synthetic',due:'2099-10-15T00:00:00.000Z'});expect(fixture.fetch).not.toHaveBeenCalled();expect(await approve(s,action)).toMatchObject({status:'accepted',result:{task:{id:'created-task'}}});await expect(approve(s,action)).rejects.toThrow('consumed');expect(fixture.mutations).toHaveBeenCalledTimes(1);expect(s.store.all('SELECT * FROM schedules')).toEqual([]);
});
it('does not duplicate a task creation when Google acceptance is lost',async()=>{
  const s=await instance(settings=>{settings.tasks!.write=true;}),fixture=tasksFetch(),{action}=await invoke(s,'google_tasks',{action:'create',taskListId:'list',title:'Synthetic'}),original=fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation(async(url,options)=>{if(options?.method==='POST')throw new Error('Synthetic lost acknowledgment');return original(url,options);});
  expect(await approve(s,action)).toMatchObject({status:'uncertain'});await expect(approve(s,action)).rejects.toThrow('consumed');expect(fixture.fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
});
it.each(['update','complete','reopen','delete'])('performs a version-bound Google task %s only after approval',async action=>{
  const s=await instance(settings=>{settings.tasks!.write=true;}),fixture=tasksFetch();const prepared=await invoke(s,'google_tasks',{action,taskListId:'list',taskId:'task',expectedEtag:'"v1"',...(action==='update'?{title:'Updated',dueDate:null}:{})});expect(fixture.mutations).not.toHaveBeenCalled();
  expect(await approve(s,prepared.action)).toMatchObject({status:'accepted'});expect(fixture.mutations).toHaveBeenCalledTimes(1);const options=fixture.mutations.mock.calls[0]![0];expect(options.headers['If-Match']).toBe('"v1"');expect(options.method).toBe(action==='delete'?'DELETE':'PATCH');
});
it.each(['changed','assigned'])('refuses stale/assigned task changes before the external mutation (%s)',async mode=>{
  const s=await instance(settings=>{settings.tasks!.write=true;}),fixture=tasksFetch();const {action}=await invoke(s,'google_tasks',{action:'complete',taskListId:'list',taskId:'task',expectedEtag:'"v1"'});
  if(mode==='changed')fixture.change();else fixture.assign();expect(await approve(s,action)).toMatchObject({status:'rejected'});expect(fixture.mutations).not.toHaveBeenCalled();
});
it('denies invalid task dates and write-disabled mutations without external requests',async()=>{
  const s=await instance(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
  await expect(invoke(s,'google_tasks',{action:'create',taskListId:'@default',title:'Test'})).rejects.toThrow('writes disabled');await expect(invoke(s,'google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1',values:[[1]]})).rejects.toThrow('writes disabled');
  s.settings.tasks!.write=true;await rpc(s.runtime,{op:'extensions.configure',args:{id:'google',settings:s.settings}});await s.runtime.credentials.modify('gmail',async current=>({...current!,type:'oauth',access:'synthetic-token',refresh:'refresh',expires:Date.now()+3600_000,scopes:googleScopes(s.settings)}));
  await expect(invoke(s,'google_tasks',{action:'create',taskListId:'list',title:'Test',dueDate:'2099-02-31'})).rejects.toThrow('Invalid calendar');expect(fetch).not.toHaveBeenCalled();
});
it.each(['ephemeral','scheduled','review','untrusted','repair'])('denies Drive imports and Sheets/Tasks mutations in %s mode',async mode=>{
  const s=await instance(settings=>{settings.sheets!.write=true;settings.tasks!.write=true;});
  const session=s.runtime.newConversation('Synthetic restricted mode',mode==='ephemeral'),ctx={...owner(s),conversationId:session.id,mode:mode==='ephemeral'?'ephemeral':mode==='scheduled'?'scheduled':mode==='review'?'review':'foreground'} as Envelope;
  if(mode==='untrusted')ctx.source={...source,trustedOwner:false};if(mode==='repair')(s.runtime as any).citationRepair.add(ctx.runId);
  if(mode!=='ephemeral')s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',ctx.runId,session.id,ctx.runId,json(ctx),'running',1,1);
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
  for(const [name,args]of [['google_drive',{action:'import',fileId:'file'}],['google_sheets',{action:'update',spreadsheetId:'sheet',range:'Sheet1!A1',values:[[1]]}],['google_tasks',{action:'create',taskListId:'list',title:'Test'}]] as const)await expect(s.runtime.availableTools(ctx).find(t=>t.name===name)!.execute(id(),args)).rejects.toThrow('foreground');
  expect(fetch).not.toHaveBeenCalled();expect(s.store.all("SELECT * FROM extension_storage WHERE key LIKE 'action:%'")).toEqual([]);expect(s.store.all('SELECT * FROM attachments')).toEqual([]);
});
it('keeps new-service reads volatile in ephemeral work without importing or creating durable journals',async()=>{
  const s=await instance(),session=s.runtime.newConversation('Synthetic ephemeral reads',true),ctx={...owner(s),conversationId:session.id,mode:'ephemeral' as const};
  const tables=['messages','operations','run_sources','documents','attachments'],before=tables.map(table=>s.store.all(`SELECT * FROM ${table}`));
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{const u=new URL(String(url));if(u.hostname==='sheets.googleapis.com')return Response.json({spreadsheetId:'sheet',properties:{title:'Synthetic'}});if(u.hostname==='www.googleapis.com')return Response.json({id:'file',name:'Synthetic.txt',version:'1',mimeType:'text/plain'});if(u.hostname==='people.googleapis.com')return Response.json({connections:[]});return Response.json({items:[]});});
  for(const [name,args]of [['google_contacts',{action:'list'}],['google_drive',{action:'read',fileId:'file'}],['google_sheets',{action:'read',spreadsheetId:'sheet'}],['google_tasks',{action:'lists'}]] as const)await s.runtime.availableTools(ctx).find(t=>t.name===name)!.execute(id(),args);
  expect(tables.map(table=>s.store.all(`SELECT * FROM ${table}`))).toEqual(before);expect(s.faux.state.callCount).toBe(0);
});
it('rejects extra authority fields, unsupported actions and traversal-shaped resource IDs before network access',async()=>{
  const s=await instance(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
  for(const [tool,args]of [['google_contacts',{action:'read',resourceName:'people/../../token'}],['google_contacts',{action:'create',name:'No'}],['google_drive',{action:'read',fileId:'../../token'}],['google_sheets',{action:'read',spreadsheetId:'sheet',ownerId:'foreign'}],['google_tasks',{action:'read',taskListId:'..',taskId:'task'}]] as const)await expect(invoke(s,tool,args)).rejects.toThrow('Invalid input');expect(fetch).not.toHaveBeenCalled();
});
