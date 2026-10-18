import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync, cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initialize, atomicWrite } from '../src/config.js';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setup, source, waitFor, loadTools } from './helpers.js';
import { Store, hash } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { DocumentServices } from '../src/document-services.js';
import { backup, restore } from '../src/backup.js';
import { rpc } from '../src/daemon.js';
import { anydocConverter } from '../src/converter.js';
const instances:ReturnType<typeof setup>[]=[];
const instance=()=>{const s=setup();instances.push(s);return s;};
afterEach(async()=>{vi.restoreAllMocks();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}});
const fixtureRoot=join(import.meta.dirname,'fixtures','knowledge');
const fixtures=JSON.parse(readFileSync(join(fixtureRoot,'manifest.json'),'utf8')).fixtures as {file:string;hash:string;expectedOutcome:string;expectedText:string;assetHashes?:string[]}[];
for(const fixture of fixtures)it(`actual converter: ${fixture.file}`,async()=>{
  const bytes=readFileSync(join(fixtureRoot,fixture.file));expect(hash(bytes)).toBe(fixture.hash);
  const result=await anydocConverter.convert(bytes,fixture.file,'application/octet-stream');
  expect(result.status).toBe(fixture.expectedOutcome);expect(result.originalHash).toBe(fixture.hash);
  if(fixture.expectedText)expect(result.markdown).toContain(fixture.expectedText);
  for(const expected of fixture.assetHashes??[])expect(result.assets.some(asset=>hash(asset.data)===expected)).toBe(true);
  if(fixture.file==='digital.pdf'){expect(result.structure).toBeUndefined();expect(result.locators).toEqual(['markdown_lines']);}
  if(fixture.file==='mixed.pdf'){expect(result.markdown).toBeUndefined();expect(result.error?.pages).toEqual([2]);expect(result.error?.pageCount).toBe(2);}
  if(fixture.file==='annotations.docx'){expect(result.markdown).toContain('Footnote qualification');expect(result.markdown).not.toContain('Deleted allocation');expect(result.markdown).not.toContain('COMMENT-503');expect(result.warnings.join()).toContain('revision');}
});
it('preserves failed inputs, structured assets, idempotent submissions and restart jobs',async()=>{
  const s=instance();const bytes=readFileSync(join(fixtureRoot,'contract.docx'));
  const attachment=s.runtime.media.save(bytes,'contract.docx','application/octet-stream');const doc=await s.runtime.knowledge.importAttachment(attachment,'event1');
  expect((await s.runtime.knowledge.importAttachment(attachment,'event1')).id).toBe(doc.id);
  expect((await s.runtime.knowledge.importAttachment(attachment,'event2')).id).not.toBe(doc.id);
  await s.runtime.knowledge.work();const rev=s.runtime.knowledge.revision(doc.id),result=JSON.parse(rev.conversion!);
  expect(result.structure.data.blocks.length).toBeGreaterThan(0);expect(hash(s.runtime.knowledge.original(doc.id,1,0).bytes)).toBe(result.assets[0].hash);
  expect(hash(s.runtime.knowledge.original(doc.id).bytes)).toBe(hash(bytes));
  const scan=s.runtime.media.save(readFileSync(join(fixtureRoot,'scan.pdf')),'scan.pdf','application/pdf');const failed=await s.runtime.knowledge.importAttachment(scan,'scan');
  await s.runtime.knowledge.work();await s.runtime.knowledge.work();expect(s.runtime.knowledge.revision(failed.id).extraction).toBe('needs_ocr');expect(s.runtime.knowledge.original(failed.id).bytes.length).toBeGreaterThan(0);
  s.store.run("UPDATE document_jobs SET status='running' WHERE document_id=?",failed.id);
  const reopened=new Store(s.root,s.config),r=new Runtime(reopened);try{expect(reopened.get<any>('SELECT status FROM document_jobs WHERE document_id=?',failed.id).status).toBe('pending');expect(r.knowledge.original(doc.id).bytes).toEqual(bytes);}finally{await r.close();reopened.close();}
});
it('revision-checked notes, targeted checklist edits, exhaustive items and historical citations',async()=>{
  const s=instance(),k=s.runtime.knowledge,n=k.createNote('Packing','Intro unchanged.','note');
  k.checklist(n.id,1,undefined,'Passport');const first=k.items(n.id)[0]!;k.checklist(n.id,2,undefined,'Jacket');k.checklist(n.id,3,first.id,undefined,true);
  expect(k.items(n.id)).toHaveLength(2);expect(k.items(n.id)[0]!.completed).toBe(true);expect(k.revision(n.id).note_text).toContain('Intro unchanged');
  expect(()=>k.edit(n.id,1,'Intro','Changed')).toThrow('Revision conflict');expect(()=>k.edit(n.id,4,'not present','x')).toThrow('exactly one');
  expect(k.resolve(k.read(n.id).citation!).revision).toBe(4);expect(k.read(n.id,1).historical).toBe(true);
  expect(()=>k.resolve(k.read(n.id).citation!.replace(':L1-',':L999-'))).toThrow();
});
it('distinguishes complete documents from head, footer and character windows without breaking citations',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Fictional confirmation',['Outbound March 21, 2034 at 11:35.',...Array.from({length:40},(_,i)=>`Routine clause ${i}.`),'Roaming and privacy footer.'].join('\n'),'coverage-fixture');
  const full=k.read(doc.id);expect(full.completeDocument).toBe(true);expect(full.truncated).toBe(false);
  const head=k.read(doc.id,undefined,1,8);expect(head).toMatchObject({completeDocument:false,truncated:false});expect(k.resolve(head.citation!).text).toBe(head.text);
  const tail=k.read(doc.id,undefined,full.totalLines!-3,12);expect(tail).toMatchObject({completeDocument:false,truncated:false,toLine:full.totalLines});expect(tail.text).not.toContain('Outbound');expect(k.resolve(tail.citation!).text).toBe(tail.text);
  const chars=k.read(doc.id,undefined,1,80,full.totalChars!-15,10);expect(chars.completeDocument).toBe(false);expect(k.resolve(chars.citation!).text).toBe(chars.text);
  const lookup=await k.search('Roaming','lexical',5);expect(lookup.results).toContainEqual(expect.objectContaining({documentId:doc.id,completeDocument:false,truncated:false,toLine:full.totalLines}));expect(lookup.results[0]!.fromLine).toBeGreaterThan(1);
});
it('real QMD lexical update/removal, source validation and two-owner isolation',async()=>{
  const a=instance(),b=instance();const da=a.runtime.knowledge.createNote('Shared','IDENT-888 secret amber.','shared'),db=b.runtime.knowledge.createNote('Shared','IDENT-888 secret violet.','shared');
  const found=await a.runtime.knowledge.search('IDENT-888','lexical');expect(found.results.map(r=>r.documentId)).toContain(da.id);expect(JSON.stringify(found)).not.toContain('violet');expect(()=>a.runtime.knowledge.read(db.id)).toThrow('not found');expect(()=>a.runtime.knowledge.original(db.id)).toThrow('not found');
  a.runtime.knowledge.edit(da.id,1,'amber','silver');expect((await a.runtime.knowledge.search('silver','lexical')).results[0]?.revision).toBe(2);
  const oldCitation=a.runtime.knowledge.read(da.id).citation!;await a.runtime.knowledge.operate({action:'delete',id:da.id});expect((await a.runtime.knowledge.search('IDENT-888','lexical')).results).toEqual([]);expect(()=>a.runtime.knowledge.resolve(oldCitation)).toThrow();
  expect(existsSync(join(a.root,'knowledge','objects',da.id))).toBe(false);expect(()=>a.runtime.knowledge.createNote('Replay','IDENT-888 secret amber.','shared')).toThrow('deleted');
},20_000);
it('idle indexing leaves QMD caches alone, and semantic-only work does not update lexical indexes',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Index fixture','INDEX-901 original.','index-fixture');
  const request=vi.spyOn(k.retrieval,'request').mockResolvedValue({errors:0});
  await k.index(false);expect(request.mock.calls.map(call=>call[0])).toEqual(['update']);
  expect(k.revision(doc.id)).toMatchObject({lexical:'ready',semantic:'pending'});
  request.mockClear();await k.index(true);expect(request.mock.calls.map(call=>call[0])).toEqual(['embed']);
  expect(k.revision(doc.id).semantic).toBe('ready');
  request.mockClear();await k.index(true);await k.index(false);expect(request).not.toHaveBeenCalled();
  k.edit(doc.id,1,'original','changed');await k.index(true);
  expect(request.mock.calls.map(call=>call[0])).toEqual(['update','embed']);expect(k.revision(doc.id)).toMatchObject({lexical:'ready',semantic:'ready'});
});
it('retries failed semantic chunks without clearing query caches or labeling failures ready',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Retry fixture','INDEX-902 original.','retry-fixture');
  const request=vi.spyOn(k.retrieval,'request').mockResolvedValue({errors:0});await k.index(false);request.mockClear();
  request.mockResolvedValueOnce({errors:1});await expect(k.index(true)).rejects.toThrow('failed chunks');
  expect(k.revision(doc.id).semantic).toBe('pending');await k.index(true);
  expect(request.mock.calls.map(call=>call[0])).toEqual(['embed','embed']);expect(k.revision(doc.id).semantic).toBe('ready');
});
it('services pending lexical and cleanup flags without a dirty generation, including after the last deletion',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Cleanup fixture','INDEX-903 original.','cleanup-fixture');
  const request=vi.spyOn(k.retrieval,'request').mockResolvedValue({errors:0});await k.index(true);request.mockClear();
  s.store.run("UPDATE document_revisions SET lexical='pending' WHERE document_id=?",doc.id);await k.index(false);
  expect(request.mock.calls.map(call=>call[0])).toEqual(['update']);request.mockClear();
  await k.operate({action:'delete',id:doc.id});s.store.run("DELETE FROM meta WHERE key='knowledge.dirty'");await k.index(true);
  expect(request.mock.calls.map(call=>call[0])).toEqual(['update','cleanup']);expect(s.store.meta('knowledge.cleanup')).toBeUndefined();
  request.mockClear();await k.index(true);expect(request).not.toHaveBeenCalled();
});
it('index acknowledgments cannot mark a concurrent replacement ready or discard its dirty generation',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Concurrent fixture','INDEX-904 original.','concurrent-fixture');
  vi.spyOn(k.retrieval,'request').mockImplementation(async(op)=>{if(op==='update')k.edit(doc.id,1,'original','changed');return {errors:0} as any;});
  await k.index(true);expect(k.revision(doc.id)).toMatchObject({revision:2,lexical:'pending',semantic:'pending'});
  expect(s.store.meta('knowledge.dirty')).toBeDefined();
});
it('auto search uses quick fusion, preserves explicit hybrid and falls back visibly without trusting stale results',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Routing fixture','The first launch phrase is amber sky.','routing-fixture');
  const request=vi.spyOn(k.retrieval,'request').mockResolvedValue({errors:0});await k.index(true);request.mockClear();
  const current={filepath:`qmd://knowledge/${doc.id}-r1.md`,body:k.revision(doc.id).markdown};request.mockResolvedValue([current]);
  expect((await k.search('first launch phrase')).strategy).toBe('fast');expect(request.mock.calls.map(call=>call[0])).toEqual(['fast']);
  request.mockClear();expect((await k.search('first launch phrase','hybrid')).strategy).toBe('hybrid');expect(request.mock.calls.map(call=>call[0])).toEqual(['hybrid']);
  request.mockClear();request.mockRejectedValueOnce(new Error('Quick semantic unavailable')).mockResolvedValueOnce([current]);
  expect(await k.search('first launch phrase')).toMatchObject({strategy:'lexical',fallback:'Quick semantic unavailable',results:[{documentId:doc.id}]});
  expect(request.mock.calls.map(call=>call[0])).toEqual(['fast','lexical']);
  request.mockResolvedValue([{...current,body:'Forged evidence.'},{...current,filepath:`qmd://knowledge/${doc.id}-r999.md`}]);
  expect((await k.search('first launch phrase')).results).toEqual([]);
  request.mockClear();expect((await k.search(doc.id)).strategy).toBe('lexical');
});
it('reconciles untrusted projections and symlinks without importing them',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Original','CANON-21 only.','canonical');k.reconcile();const path=k.projection(doc.id,1);writeFileSync(path,'FAKE SECRET');const external=join(s.root,'not-indexed.txt');writeFileSync(external,'OTHER CONTENT');symlinkSync(external,join(s.root,'knowledge','searchable','foreign.md'));k.reconcile();expect(readFileSync(path,'utf8')).toContain('CANON-21');expect(existsSync(join(s.root,'knowledge','searchable','foreign.md'))).toBe(false);expect(readFileSync(external,'utf8')).toBe('OTHER CONTENT');
});
it('deletion during actual conversion cannot publish or resurrect a document',async()=>{
  const s=instance(),k=s.runtime.knowledge,a=s.runtime.media.save(readFileSync(join(fixtureRoot,'long.pdf')),'long.pdf','application/pdf'),doc=await k.importAttachment(a,'late');
  const work=k.work();await k.operate({action:'forget',id:doc.id});await work;expect(s.store.get<any>('SELECT markdown FROM document_revisions WHERE document_id=?',doc.id).markdown).toBeNull();expect(s.store.get<any>('SELECT status FROM document_jobs WHERE document_id=?',doc.id).status).toBe('cancelled');
  const retry=s.runtime.media.save(readFileSync(join(fixtureRoot,'long.pdf')),'same.pdf','application/pdf');await expect(k.importAttachment(retry,'new event')).rejects.toThrow('forgotten');
});
it('document-backed facts are stored directly and forgetting preserves independent memory',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Evidence','Owner quoted preference: green tea.','memory-source');
  const independent=s.runtime.remember('coffee','espresso') as any;
  const promotion={id:doc.id,entity:`owner:${s.config.ownerId}`,kind:'preference',key:'tea',value:'green',quote:'green tea',tags:['food']};
  const record=await rpc(s.runtime,{op:'memory.documentStore',args:promotion}) as any;
  expect(s.runtime.promoteDocumentMemory(promotion).id).toBe(record.id);expect(record.status).toBe('stored');expect(record.tags).toEqual(['food']);
  expect(s.runtime.memory.list()).toEqual(expect.arrayContaining([expect.objectContaining({id:record.id})]));
  expect(s.runtime.memory.read(record.id).evidence).toMatchObject({id:`document:${doc.id}:r1`});expect(s.store.all('SELECT * FROM memory_confirmations')).toEqual([]);
  await expect(rpc(s.runtime,{op:'memory.documentCandidate',args:promotion})).rejects.toThrow('Unknown operation');
  await k.operate({action:'forget',id:doc.id});expect(()=>s.runtime.memory.read(record.id)).toThrow();expect(s.runtime.memory.read(independent.id).memory.value).toBe('espresso');expect(s.store.all('SELECT * FROM memory_tags')).toEqual([]);
});
it('successful restore retains binary originals/assets, historical note bytes and rebuilds readiness',async()=>{
  const s=instance(),k=s.runtime.knowledge,bytes=readFileSync(join(fixtureRoot,'contract.docx')),doc=await k.importAttachment(s.runtime.media.save(bytes,'contract.docx','application/octet-stream'),'restore-doc');await k.work();const note=k.createNote('History','REST-510 before.','restore-note');k.edit(note.id,1,'before','after');const snapshot=await backup(s.store);await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);await restore(s.root,snapshot.path,true);const store=new Store(s.root,s.config),runtime=new Runtime(store);try{expect(runtime.knowledge.original(doc.id).bytes).toEqual(bytes);expect(hash(runtime.knowledge.original(doc.id,1,0).bytes)).toBe(fixtures.find(f=>f.file==='contract.docx')!.assetHashes![0]);expect(runtime.knowledge.original(note.id,1).bytes.toString()).toContain('before');expect(runtime.knowledge.read(note.id).text).toContain('after');expect(runtime.knowledge.revision(note.id).semantic).toBe('pending');}finally{await runtime.close();store.close();rmSync(s.root,{recursive:true,force:true});}
});
it('backup and restore retain originals, editable note history and deletion tombstones',async()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('Backed up','BACKUP-100 old.','backup');k.edit(doc.id,1,'old','new');const snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pico-knowledge-backup-'));cpSync(snapshot.path,external,{recursive:true});expect(snapshot.manifest.files.filter(f=>f.path.startsWith('knowledge/objects'))).toHaveLength(2);
  await k.operate({action:'forget',id:doc.id});await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);
  try{await restore(s.root,external,true);const store=new Store(s.root,s.config),runtime=new Runtime(store);try{expect(()=>runtime.knowledge.read(doc.id)).toThrow();expect(existsSync(join(s.root,'knowledge','objects',doc.id))).toBe(false);}finally{await runtime.close();store.close();}}finally{rmSync(s.root,{recursive:true,force:true});rmSync(external,{recursive:true,force:true});}
});
it('real tool path persists a note, denies ephemeral/untrusted mutations and validates complete arguments',async()=>{
  const s=instance();s.faux.appendResponses([loadTools('notes'),fauxAssistantMessage([fauxToolCall('notes',{action:'create',title:'Tool note',markdown:'TOOL-909 value.'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Saved.')])]);
  const c=s.runtime.newConversation();const run=await s.runtime.ingest({conversationId:c.id,requestId:'tool',text:'Save a note'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');expect(s.runtime.knowledge.list().total).toBe(1);
  for(const ephemeral of [true,false]){const c=s.runtime.newConversation('Denied',ephemeral);s.faux.appendResponses([loadTools('notes'),fauxAssistantMessage([fauxToolCall('notes',{action:'create',title:'Denied',markdown:'bad'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Cannot save.')])]);const r=await s.runtime.ingest({conversationId:c.id,requestId:`denial-${ephemeral}`,text:'Save'}, {...source,trustedOwner:ephemeral});await waitFor(()=>s.runtime.run(r.id).status==='completed');expect(s.runtime.knowledge.list().total).toBe(1);}
  await expect(rpc(s.runtime,{op:'knowledge',args:{action:'create',title:'bad',markdown:'x',submission:'x',ownerId:'other'}})).rejects.toThrow();
});
it('quarantines invalid citations and permits only one read-only repair',async()=>{
  const s=instance(),doc=s.runtime.knowledge.createNote('Cited','CITE-123 fact.','cited'),citation=s.runtime.knowledge.read(doc.id).citation!;
  s.faux.appendResponses([fauxAssistantMessage([fauxText(`Draft pico:${doc.id}:r1`)]),fauxAssistantMessage([fauxText(`Verified ${citation}`)])]);
  const c=s.runtime.newConversation(),r=await s.runtime.ingest({conversationId:c.id,requestId:'repair',text:'CITE-123'},source);await waitFor(()=>s.runtime.run(r.id).status==='completed');expect(s.runtime.run(r.id).partial).toContain(citation);
  expect(s.store.all<{text:string}>("SELECT text FROM messages WHERE role='assistant'").some(row=>row.text===`Draft pico:${doc.id}:r1`)).toBe(false);
  s.faux.appendResponses([fauxAssistantMessage([fauxText('Bad pico:fictional')]),fauxAssistantMessage([fauxText('Still bad pico:fictional')])]);const c2=s.runtime.newConversation(),r2=await s.runtime.ingest({conversationId:c2.id,requestId:'failed-repair',text:'CITE-123'},source);await waitFor(()=>s.runtime.run(r2.id).status==='failed');expect(s.runtime.run(r2.id).partial).not.toContain('fictional');
});
it('replaces imported originals, preserves exact revision history and rebuilds a corrupt QMD database',async()=>{
  const s=instance(),k=s.runtime.knowledge,a=s.runtime.media.save(Buffer.from('IMP-300 old value.'),'first.txt','text/plain'),doc=await k.importAttachment(a,'replace');await k.work();
  const b=s.runtime.media.save(Buffer.from('IMP-300 new value.'),'second.txt','text/plain');await k.replaceOriginal(doc.id,1,b);await k.work();expect(k.read(doc.id).revision).toBe(2);expect(k.original(doc.id,1).name).toBe('first.txt');expect(k.original(doc.id,1).bytes.toString()).toContain('old');
  await k.search('IMP-300','lexical');await k.retrieval.close();writeFileSync(join(s.root,'knowledge','qmd.sqlite'),'corrupt');await k.operate({action:'rebuild'});expect((await k.search('IMP-300','lexical')).results[0]?.revision).toBe(2);
  await k.operate({action:'forget',id:doc.id});expect(existsSync(join(s.root,'attachments',a))).toBe(false);expect(existsSync(join(s.root,'attachments',b))).toBe(false);
},15_000);
it('replacement refuses ephemeral bytes without creating a durable revision or original',async()=>{
  const s=instance(),k=s.runtime.knowledge,original=s.runtime.media.save(Buffer.from('Retained original.'),'original.txt','text/plain');
  const doc=await k.importAttachment(original,'replace-private'),privateId=s.runtime.media.save(Buffer.from('Ephemeral replacement secret.'),'private.txt','text/plain',undefined,true);
  await expect(rpc(s.runtime,{op:'knowledge',args:{action:'replace',id:doc.id,expectedRevision:1,attachmentId:privateId}})).rejects.toThrow(/Retained attachment/);
  expect(k.document(doc.id)).toMatchObject({current_revision:1,attachment_id:original});expect(k.original(doc.id).bytes.toString()).toBe('Retained original.');
  expect(existsSync(k.path(doc.id,2))).toBe(false);expect(s.store.all('SELECT * FROM document_revisions WHERE document_id=?',doc.id)).toHaveLength(1);
});
it('plain authored checklists acquire stable IDs and exhaustive enumeration includes every item',()=>{
  const s=instance(),k=s.runtime.knowledge,body=Array.from({length:130},(_,i)=>`- [ ] Item ${i}`).join('\n'),n=k.createNote('Complete list',body,'complete-list');expect(k.items(n.id)).toHaveLength(130);expect(k.createNote('Complete list',body,'complete-list').id).toBe(n.id);const first=k.items(n.id)[0]!;k.checklist(n.id,1,first.id,undefined,true);expect(k.items(n.id)[0]?.id).toBe(first.id);
});
it('long-line spans and non-ASCII UTF-16 offsets remain resolvable',()=>{
  const s=instance(),k=s.runtime.knowledge,n=k.createNote('Long line','è'.repeat(45000)+' OFFSET-771 final fact.','long-line');const first=k.read(n.id);expect(first.citation).toMatch(/:C0-/);expect(k.resolve(first.citation!).text).toBe(first.text);const tail=k.read(n.id,undefined,1,80,44800,1000);expect(tail.text).toContain('OFFSET-771');expect(k.resolve(tail.citation!).text).toBe(tail.text);
});
it('forgetting byte-identical imported copies preserves independent authored text',async()=>{
  const s=instance(),k=s.runtime.knowledge,bytes=Buffer.from('DUP-812 shared source.'),a=s.runtime.media.save(bytes,'copy.txt','text/plain'),first=await k.importAttachment(a,'copy-a'),second=await k.importAttachment(a,'copy-b'),note=k.createNote('Independent duplicate',bytes.toString(),'own-duplicate');await k.operate({action:'forget',id:first.id});expect(()=>k.read(second.id)).toThrow();expect(k.read(note.id).text).toContain('DUP-812');await expect(k.importAttachment(s.runtime.media.save(bytes,'copy.txt','text/plain'),'copy-c')).rejects.toThrow(/forgotten/);
});
it('question wording does not block useful annotations or turn model-authored notes into owner assertions',async()=>{
  const s=instance();s.faux.appendResponses([loadTools('notes'),fauxAssistantMessage([fauxToolCall('notes',{action:'create',title:'Budget question',markdown:'The approved amount is still unknown.'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Amount unknown; question noted.')])]);
  const c=s.runtime.newConversation(),r=await s.runtime.ingest({conversationId:c.id,requestId:'question-note',text:'What was the approved amount?'},source);await waitFor(()=>s.runtime.run(r.id).status==='completed');
  const doc=s.store.get<{id:string}>("SELECT id FROM documents WHERE title='Budget question'")!,input=s.store.get<{id:string}>("SELECT id FROM messages WHERE run_id=? AND role='user'",r.id)!;
  expect(doc).toBeDefined();expect(s.runtime.memory.source(`document:${doc.id}:r1`)?.actor).toBe(`assistant:${s.config.instanceId}`);
  expect(JSON.parse(s.runtime.knowledge.revision(doc.id).conversion!).dependencies).toContain(input.id);expect(s.store.all('SELECT * FROM memories')).toEqual([]);
});
it.each(['delete','forget'])('allows model-selected document %s without explicit command wording and journals the actual erasure',async action=>{
  const s=instance(),doc=s.runtime.knowledge.createNote('Obsolete note','No longer useful.','obsolete');
  s.faux.appendResponses([loadTools('documents'),fauxAssistantMessage([fauxToolCall('documents',{action,id:doc.id})],{stopReason:'toolUse'})]);
  const c=s.runtime.newConversation(),r=await s.runtime.ingest({conversationId:c.id,requestId:action,text:'This old note is no longer useful.'},source);await waitFor(()=>s.runtime.run(r.id).status==='completed');
  expect(()=>s.runtime.knowledge.document(doc.id)).toThrow('not found');expect(existsSync(s.runtime.knowledge.path(doc.id,1))).toBe(false);
  expect(s.store.get<{status:string}>("SELECT status FROM operations WHERE run_id=? AND tool='$documents'",r.id)?.status).toBe('completed');
});
it('assigns model import identities, reuses retained attachments and preserves input/channel lineage without save wording',async()=>{
  const s=instance(),attachmentId=s.runtime.media.save(Buffer.from('DOC-861 original.'),'guide.txt','text/plain');
  const args={action:'import',attachmentId,title:'Useful guide'};
  s.faux.appendResponses([loadTools('documents'),fauxAssistantMessage([fauxToolCall('documents',args),fauxToolCall('documents',args)],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Original preserved.')])]);
  const c=s.runtime.newConversation(),r=await s.runtime.ingest({conversationId:c.id,requestId:'implicit-import',text:'This guide could be useful later.'},source);await waitFor(()=>s.runtime.run(r.id).status==='completed');
  const input=s.store.get<{id:string}>("SELECT id FROM messages WHERE run_id=? AND role='user'",r.id)!;
  const docs=s.store.all<{id:string;submission:string;source_id:string;channel:string}>('SELECT id,submission,source_id,channel FROM documents');
  expect(docs).toHaveLength(1);expect(docs[0]).toMatchObject({source_id:input.id,channel:source.channel});expect(docs[0]!.submission).toMatch(/^import:/);
  const results=s.store.all<{body:string}>("SELECT body FROM messages WHERE run_id=? AND role='toolResult' AND json_extract(body,'$.toolName')='documents'",r.id).map(row=>JSON.parse(row.body));
  expect(results).toHaveLength(2);expect(results.every(result=>!result.isError)).toBe(true);
  expect(results.map(result=>JSON.parse(result.content[0].text).id)).toEqual([docs[0]!.id,docs[0]!.id]);
  expect(s.runtime.knowledge.original(docs[0]!.id).bytes.toString()).toBe('DOC-861 original.');
  await expect(rpc(s.runtime,{op:'knowledge',args:{action:'import',attachmentId}})).rejects.toThrow('Invalid input');
});
it('reuses the current imported revision instead of replaying an initial submission against replaced bytes',async()=>{
  const s=instance(),first=s.runtime.media.save(Buffer.from('Before.'),'first.txt','text/plain'),doc=await s.runtime.knowledge.importAttachment(first,'original');
  const replacement=s.runtime.media.save(Buffer.from('After.'),'second.txt','text/plain');await s.runtime.knowledge.replaceOriginal(doc.id,1,replacement);
  s.faux.appendResponses([loadTools('documents'),fauxAssistantMessage([fauxToolCall('documents',{action:'import',attachmentId:replacement})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Already preserved.')])]);
  const c=s.runtime.newConversation(),r=await s.runtime.ingest({conversationId:c.id,requestId:'reuse-replaced',text:'This version may be useful later.'},source);await waitFor(()=>s.runtime.run(r.id).status==='completed');
  const result=JSON.parse(s.store.get<{body:string}>("SELECT body FROM messages WHERE run_id=? AND role='toolResult' AND json_extract(body,'$.toolName')='documents'",r.id)!.body);
  expect(result.isError).not.toBe(true);expect(JSON.parse(result.content[0].text)).toMatchObject({id:doc.id,current_revision:2});
  expect(s.runtime.knowledge.list().total).toBe(1);expect(s.runtime.knowledge.original(doc.id).bytes.toString()).toBe('After.');expect(s.runtime.knowledge.original(doc.id,1).bytes.toString()).toBe('Before.');
});
it('document validation reports the chosen action fields and bounds, without accepting extras',async()=>{
  const s=instance(),doc=s.runtime.knowledge.createNote('Validation fixture','Original.','validation-fixture'),c=s.runtime.newConversation();
  const service=new DocumentServices(s.runtime,{ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:c.id,runId:'',source,mode:'foreground'},()=>false);
  await expect(service.operate({action:'delete',id:doc.id,expectedRevision:1},undefined,'invalid-delete')).rejects.toThrow('/expectedRevision');
  await expect(service.operate({action:'list',query:'Validation fixture'},undefined,'invalid-list')).rejects.toThrow('/query');
  await expect(service.operate({action:'search',query:'fixture',limit:20},undefined,'invalid-search')).rejects.toThrow('/limit');
  expect(s.runtime.knowledge.document(doc.id)).toBeDefined();
  await service.operate({action:'delete',id:doc.id},undefined,'valid-delete');expect(()=>s.runtime.knowledge.document(doc.id)).toThrow('not found');
});
it.each(['ephemeral','scheduled','review','untrusted','citation-repair'] as const)('does not process a pending PDF from a %s document read',async mode=>{
  const s=instance(),attachment=s.runtime.media.save(readFileSync(join(fixtureRoot,'digital.pdf')),'report.pdf','application/pdf'),doc=await s.runtime.knowledge.importAttachment(attachment,'pending-pdf'),work=vi.spyOn(s.runtime.knowledge,'work');
  const service=new DocumentServices(s.runtime,{ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:s.runtime.newConversation().id,runId:'',source:{...source,trustedOwner:mode!=='untrusted'},mode:mode==='untrusted'||mode==='citation-repair'?'foreground':mode},()=>mode==='citation-repair');
  expect(await service.operate({action:'read',id:doc.id},undefined,'read')).toMatchObject({extraction:'pending'});
  expect(work).not.toHaveBeenCalled();expect(s.store.get('SELECT status,attempts FROM document_jobs WHERE document_id=?',doc.id)).toEqual({status:'pending',attempts:0});
});
it('keeps citation repair read-only for all canonical document writes',async()=>{
  const s=instance(),doc=s.runtime.knowledge.createNote('Evidence','Original.','original'),c=s.runtime.newConversation();
  const service=new DocumentServices(s.runtime,{ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:c.id,runId:crypto.randomUUID(),source,mode:'foreground'},()=>true);
  for(const request of [{action:'create',title:'New',markdown:'New'},{action:'edit',id:doc.id,expectedRevision:1,find:'Original.',replace:'Changed.'},{action:'import',attachmentId:'untrusted'},{action:'delete',id:doc.id},{action:'forget',id:doc.id}])await expect(service.operate(request,undefined,'repair')).rejects.toThrow('cannot persist');
  expect(s.runtime.knowledge.revision(doc.id).note_text).toBe('Original.');expect(s.runtime.knowledge.list().total).toBe(1);
});
it('model-authored notes carry evidence lineage and erasure preserves independent notes',async()=>{
  const s=instance(),k=s.runtime.knowledge,original=k.createNote('Evidence','PROV-510 fictional source.','prov-source'),independent=k.createNote('Independent','I typed this separately.','independent');
  s.faux.appendResponses([loadTools('notes','documents'),fauxAssistantMessage([fauxToolCall('documents',{action:'read',id:original.id})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxToolCall('notes',{action:'create',title:'Derived',markdown:'PROV-510 fictional source.'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Created.')])]);const c=s.runtime.newConversation(),r=await s.runtime.ingest({conversationId:c.id,requestId:'derive',text:`Save a note based on ${original.id}.`},source);await waitFor(()=>s.runtime.run(r.id).status==='completed');const derived=s.store.get<{id:string}>("SELECT id FROM documents WHERE title='Derived'")!;expect(derived,JSON.stringify(s.store.all("SELECT body FROM messages WHERE role='toolResult'"))).toBeDefined();expect(s.runtime.memory.source(`document:${derived.id}:r1`)?.actor).toBe(`assistant:${s.config.instanceId}`);
  await k.operate({action:'delete',id:original.id});expect(()=>k.read(derived.id)).toThrow();expect(existsSync(k.path(derived.id,1))).toBe(false);expect(k.read(independent.id).text).toContain('separately');
});
it('authenticated ephemeral uploads cannot acquire durable knowledge even with a false persistence flag',async()=>{
  const s=instance(),c=s.runtime.newConversation('Private',true);const a=await rpc(s.runtime,{op:'attachments.upload',args:{conversationId:c.id,ephemeral:false,name:'private.pdf',mime:'application/pdf',data:readFileSync(join(fixtureRoot,'digital.pdf')).toString('base64')}}) as {id:string};expect(s.store.get('SELECT id FROM attachments WHERE id=?',a.id)).toBeUndefined();await expect(rpc(s.runtime,{op:'knowledge',args:{action:'import',attachmentId:a.id,submission:'no-persist'}})).rejects.toThrow(/Retained/);s.faux.appendResponses([context=>{expect(JSON.stringify(context)).toContain('PDF-901');return fauxAssistantMessage([fauxText('Read privately.')]);}]);const r=await s.runtime.ingest({conversationId:c.id,requestId:'ephemeral-pdf',text:'Read this.',attachments:[a.id]},source);await waitFor(()=>s.runtime.run(r.id).status==='completed');expect(s.store.get<{n:number}>('SELECT count(*) n FROM documents')!.n).toBe(0);
});
it('live knowledge validation rejects unknown providers before credential access',async()=>{
  await expect(promisify(execFile)(process.execPath,[join(import.meta.dirname,'..','scripts','validate-knowledge.mjs'),'--provider','typo'],{timeout:10_000})).rejects.toMatchObject({stderr:expect.stringContaining('Unknown evaluation provider')});
});
it('actual executable creates/searches/downloads durable notes without provider calls',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pico-knowledge-cli-'));const config=initialize(root,'Synthetic CLI knowledge');delete config.embeddings;config.limits.backgroundIntervalMs=3_600_000;atomicWrite(join(root,'config.json'),JSON.stringify(config));
  const cli=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,[join(import.meta.dirname,'..','dist','cli.js'),'--instance',root,...args],{timeout:15_000})).stdout);
  let pid:number|undefined;
  try{await cli('rpc','health');pid=(await cli('status')).pid;const n=await cli('rpc','knowledge',JSON.stringify({action:'create',title:'Executable note',markdown:'CLI-520 durable.',submission:'executable'}));const found=await cli('knowledge','search','CLI-520');expect(found.results[0].documentId).toBe(n.id);const output=join(root,'download.md');await cli('knowledge','original',n.id,output);expect(readFileSync(output,'utf8')).toBe('CLI-520 durable.');}
  finally{if(pid){process.kill(pid,'SIGTERM');await waitFor(()=>{try{process.kill(pid!,0);return false;}catch{return true;}},10_000);}rmSync(root,{recursive:true,force:true});}
},30_000);
it('channel attachment intake registers a durable converter job through the real RPC path',async()=>{
  const s=instance();const a=await rpc(s.runtime,{op:'attachments.upload',args:{name:'contract.docx',mime:'application/octet-stream',data:readFileSync(join(fixtureRoot,'contract.docx')).toString('base64')}}) as any;
  s.faux.appendResponses([fauxAssistantMessage([fauxText('Original retained.')])]);const c=s.runtime.newConversation();const run=await s.runtime.ingest({conversationId:c.id,requestId:'intake',text:'Keep this contract',attachments:[a.id]},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');expect(s.runtime.knowledge.list().total).toBe(1);expect(s.runtime.knowledge.revision((s.runtime.knowledge.list().documents[0] as any).id).extraction).toBe('ready');
});
it('erasure scopes derived-context clearing to the conversations and runs that used the source',async()=>{
  const s=instance(),k=s.runtime.knowledge;
  const other=s.runtime.newConversation('Unrelated');
  s.faux.appendResponses([fauxAssistantMessage([fauxText('Unrelated answer that must survive.')])]);
  const unrelated=await s.runtime.ingest({conversationId:other.id,requestId:'unrelated',text:'Unrelated question'},source);await waitFor(()=>s.runtime.run(unrelated.id).status==='completed');
  s.store.run("UPDATE conversations SET summary='Derived summary: unrelated' WHERE id=?",other.id);
  const session=s.runtime.newConversation(),target=k.createNote('Doomed','ERASE-940 value.','erase-target'),fact=s.runtime.remember('erase fixture','ERASE-940') as any;
  s.faux.appendResponses([loadTools('documents'),fauxAssistantMessage([fauxToolCall('documents',{action:'read',id:target.id}),fauxToolCall('memory_read',{id:fact.id})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Erasable answer.')])]);
  const reader=await s.runtime.ingest({conversationId:session.id,requestId:'reader',text:'Read ERASE-940'},source);await waitFor(()=>s.runtime.run(reader.id).status==='completed');
  expect(s.store.all("SELECT id FROM messages WHERE role='assistant' AND run_id=?",reader.id)).toHaveLength(3);
  await k.operate({action:'forget',id:target.id});
  // The run whose context reached the erased source keeps no derived assistant/tool history or reply.
  expect(s.store.all("SELECT id FROM messages WHERE role!='user' AND run_id=?",reader.id)).toEqual([]);expect(s.runtime.run(reader.id).status).toBe('interrupted');expect(s.runtime.run(reader.id).partial).toBe('');
  // Untouched conversations keep their answers, summaries and delivered replies.
  expect(s.runtime.run(unrelated.id).status).toBe('completed');expect(s.runtime.run(unrelated.id).partial).toContain('Unrelated answer');
  expect(s.runtime.conversation(other.id).summary).toBe('Derived summary: unrelated');
  expect(s.store.get<{n:number}>('SELECT count(*) n FROM messages WHERE conversation_id=? AND role=\'assistant\'',other.id)!.n).toBe(1);
});
it('refuses a model-initiated deletion that would also remove owner-visible notes until it is confirmed',async()=>{
  const s=instance(),c=s.runtime.newConversation('Shared');
  s.faux.appendResponses([loadTools('notes'),fauxAssistantMessage([fauxToolCall('notes',{action:'create',title:'Cantina list',markdown:'COSE-CANTINA value.'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Saved.')])]);
  const first=await s.runtime.ingest({conversationId:c.id,requestId:'first-note',text:'Save the cantina list'},source);await waitFor(()=>s.runtime.run(first.id).status==='completed');
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('notes',{action:'create',title:'Action list',markdown:'COSE-ACTION value.'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Saved.')])]);
  const second=await s.runtime.ingest({conversationId:c.id,requestId:'second-note',text:'Save the action list'},source);await waitFor(()=>s.runtime.run(second.id).status==='completed');
  const cantina=s.store.get<{id:string}>("SELECT id FROM documents WHERE title='Cantina list'")!,action=s.store.get<{id:string}>("SELECT id FROM documents WHERE title='Action list'")!;
  // The second run's prompt previewed the first note, so erasing one can legitimately reach the
  // other: that is exactly why a model-initiated erasure must be confirmed instead of silent.
  expect(JSON.parse(s.runtime.knowledge.revision(action.id).conversion!).dependencies).toContain(`document:${cantina.id}:r1`);
  s.faux.appendResponses([loadTools('documents'),fauxAssistantMessage([fauxToolCall('documents',{action:'delete',id:cantina.id})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Not removed.')])]);
  const refused=await s.runtime.ingest({conversationId:c.id,requestId:'unconfirmed',text:'Tidy up the notes that are no longer useful'},source);await waitFor(()=>s.runtime.run(refused.id).status==='completed');
  const failure=s.store.all<{body:string}>("SELECT body FROM messages WHERE run_id=? AND role='toolResult'",refused.id).map(row=>JSON.parse(row.body)).find(result=>result.isError);
  expect(failure.content[0].text).toContain('would also remove');expect(failure.content[0].text).toContain('Action list');expect(failure.content[0].text).toContain('cascade:true');
  expect(s.runtime.knowledge.read(cantina.id).text).toContain('COSE-CANTINA');expect(s.runtime.knowledge.read(action.id).text).toContain('COSE-ACTION');
  // A confirmed second call removes the target and the derived notes together.
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('documents',{action:'delete',id:cantina.id,cascade:true})],{stopReason:'toolUse'})]);
  const confirmed=await s.runtime.ingest({conversationId:c.id,requestId:'confirmed',text:'The owner confirmed removing the derived lists too'},source);await waitFor(()=>['completed','failed','cancelled'].includes(s.runtime.run(confirmed.id).status));
  expect(()=>s.runtime.knowledge.read(cantina.id)).toThrow('not found');expect(()=>s.runtime.knowledge.read(action.id)).toThrow('not found');
  expect(s.runtime.run(confirmed.id).partial).toContain('Also removed');
});
it('announces a model-initiated removal as a notice instead of a confident confirmation',async()=>{
  const s=instance(),c=s.runtime.newConversation(),doc=s.runtime.knowledge.createNote('Optional note','NOTICE-950 value.','notice-fixture');
  s.faux.appendResponses([loadTools('documents'),fauxAssistantMessage([fauxToolCall('documents',{action:'delete',id:doc.id})],{stopReason:'toolUse'})]);
  const run=await s.runtime.ingest({conversationId:c.id,requestId:'unrelated-delete',text:'Please inspect the supplied attachment.'},source);
  await waitFor(()=>['completed','failed','cancelled'].includes(s.runtime.run(run.id).status));
  const receipt=s.runtime.run(run.id).partial;
  expect(receipt).toContain('while working on your request');expect(receipt).not.toContain(`${doc.id} deleted.`);
  const named=c.id&&s.runtime.knowledge.createNote('Named note','NOTICE-951 value.','notice-fixture-2');
  s.faux.appendResponses([loadTools('documents'),fauxAssistantMessage([fauxToolCall('documents',{action:'delete',id:named.id})],{stopReason:'toolUse'})]);
  const second=await s.runtime.ingest({conversationId:c.id,requestId:'named-delete',text:`Delete the note ${named.id} now`},source);
  await waitFor(()=>['completed','failed','cancelled'].includes(s.runtime.run(second.id).status));
  expect(s.runtime.run(second.id).partial).toContain('Deleted list/note');
});
