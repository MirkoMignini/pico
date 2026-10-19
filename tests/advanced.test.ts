import { afterEach, expect, it } from 'vitest';
import { rmSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setup, reply, source, waitFor, loadTools } from './helpers.js';
import { Store, hash, id } from '../src/store.js';
import { initialize, atomicWrite } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { serve, rpc } from '../src/daemon.js';
import { Client } from '../src/client.js';
import { ChatUI } from '../src/tui.js';
import type { Terminal } from '@earendil-works/pi-tui';
import { backup, restore } from '../src/backup.js';
const cleanup:(()=>Promise<void>)[]=[];
const instance=()=>{const s=setup();cleanup.push(async()=>{await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});});return s;};
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
class Screen implements Terminal {
 columns=100;rows=35;kittyProtocolActive=false;output='';input!:(data:string)=>void;resize!:()=>void;
 start(input:(data:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}stop(){}async drainInput(){}write(data:string){this.output=(this.output+data).slice(-200_000);}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
it('runs the real Pi TUI against authenticated daemon: multiline, streaming, resize, sessions and reconnect',async()=>{
 const s=instance();atomicWrite(join(s.root,'config.json'),JSON.stringify(s.config));
 const service=await serve(s.root,{runtimeFactory:store=>new Runtime(store,s.runtime.models)});
 const terminal=new Screen(),client=new Client(s.root),ui=new ChatUI(client,terminal);
 try{
  await ui.start();await waitFor(()=>terminal.output.includes('PIKOBOT'));
  terminal.input('line one');terminal.input('\x1b\r');terminal.input('line two');expect(ui.editor.getText()).toBe('line one\nline two');ui.editor.setText('');
  reply(s.faux,'Risposta italiana **in streaming**.');await ui.submit('Two lines\nfor the owner');await waitFor(()=>!ui.editor.disableSubmit&&terminal.output.includes('Risposta italiana'));expect(terminal.output).toContain('Risposta italiana');
  terminal.columns=42;terminal.rows=15;terminal.resize();await new Promise(r=>setTimeout(r,30));
  const legacy=service.runtime.newConversation('Legacy private chat',true);await ui.submit(`/sessions ${legacy.id}`);reply(s.faux,'Private answer');await ui.submit('Private question');await waitFor(()=>!ui.editor.disableSubmit&&terminal.output.includes('volatile'));expect(terminal.output).toContain('volatile');
  await ui.submit('/new');await service.close();
  const restarted=await serve(s.root,{runtimeFactory:store=>new Runtime(store,s.runtime.models)});
  try{await new Promise(r=>setTimeout(r,1500));await ui.submit('/help');expect(await client.rpc('status')).toMatchObject({instanceId:s.config.instanceId});expect(s.faux.state.callCount).toBe(2);}finally{await restarted.close();}
 }finally{ui.close();await service.close();}
},15_000);
it('does not get stuck if a streamed completion beats its HTTP acknowledgment',async()=>{
 const s=instance(),screen=new Screen();const session=s.runtime.newConversation();let handler:(event:any)=>void=()=>{};
 const stub={ensureDaemon:async()=>{},subscribe:(callback:any,_disconnected:any,connected:any)=>{handler=callback;connected();return()=>{};},close:()=>{},rpc:async(op:string)=>{
  if(op==='instructions.preview')return{text:s.runtime.instructionPreview(session.id)};if(op==='model.capabilities')return{authentication:'fixture'};if(op==='context.usage')return{tokens:null,contextWindow:0};if(op==='thinking.get')return{level:'off',available:['off'],default:'off'};if(op==='sessions')return[session];if(op==='history')return[];if(op==='status')return{ownerName:'owner',ownerId:s.config.ownerId,instanceId:s.config.instanceId,model:{authentication:'fixture'},activeRuns:[]};
  if(op==='input'){handler({type:'settled',runId:'fast',conversationId:session.id,data:{status:'completed',text:'Fast answer'}});return{id:'fast'};}throw new Error(op);
 }};
 const ui=new ChatUI(stub as unknown as Client,screen);try{await ui.start();await ui.submit('fast');expect(ui.editor.disableSubmit).toBe(false);await ui.submit('again');expect(ui.editor.disableSubmit).toBe(false);}finally{ui.close();}
});
it('ephemeral TUI rejects persistent lifecycle commands before making any RPC',async()=>{
 const calls:string[]=[];const client={rpc:async(op:string)=>{calls.push(op);return[];},close:()=>{}} as unknown as Client;
 const ui=new ChatUI(client,new Screen());(ui as any).session={id:'volatile',ephemeral:true};
 try{for(const command of ['/extensions disable old-code','/extensions rollback old-code','/skills approve skill 1 hash','/approve code hash'])await expect(ui.submit(command)).rejects.toThrow('Ephemeral mode');expect(calls).toEqual([]);await ui.submit('/extensions');expect(calls).toEqual(['extensions.list']);}finally{ui.close();}
});
it('does not classify a tool-only limit-aborted response as a completed answer',async()=>{
 const s=instance();s.config.limits.turns=1;s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('time',{})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('must not complete')])]);
 const run=await s.runtime.ingest({requestId:'turn-limit',conversationId:s.runtime.newConversation().id,text:'bounded'},source);await waitFor(()=>!['queued','running'].includes(s.runtime.run(run.id).status));expect(s.runtime.run(run.id).status).not.toBe('completed');
});
it('deduplicates source slots and strips bilingual stop words in lexical ranking',async()=>{
 const s=instance();s.runtime.remember('beverage','tea');s.runtime.ownerEvidence('When do I prefer other unrelated things');
 const found=await s.runtime.memory.search('When do I drink tea?');expect(found.length).toBe(1);expect(found[0]!.text).toContain('tea');expect(new Set(found.map(r=>r.sourceId)).size).toBe(found.length);
});
it('archives document derivatives, verifies source linkage and reconstructs their search index',async()=>{
 const s=instance(),session=s.runtime.newConversation();const attachment=s.runtime.media.save(Buffer.from('Contratto: il totale è 317 euro.'),'invoice.txt','text/plain',session.id);reply(s.faux,'Document read.');
 const run=await s.runtime.ingest({requestId:'document',conversationId:session.id,text:'Read my document',attachments:[attachment]},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
 expect(s.store.all('SELECT * FROM media_derivatives')).toHaveLength(1);s.runtime.memory.rebuild();const found=await s.runtime.memory.search('317');expect(found[0]!.kind).toBe('media-derivative');expect(s.runtime.memory.source(found[0]!.sourceId)?.text).toBe('Read my document');
});
it('reviews demonstrated work into a hash-approved skill without granting code authority; forgetting removes derived skills',async()=>{
 const s=instance(),fact=s.runtime.remember('demo setting','fixture-setting') as any;
 s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('memory_read',{id:fact.id})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('The procedure worked.')]),fauxAssistantMessage([fauxText('```json\n'+JSON.stringify([{name:'Review setting',scope:'global',instructions:'Read the setting, validate it, then report the result.'}])+'\n```')])]);
 const run=await s.runtime.ingest({requestId:'learn',conversationId:s.runtime.newConversation().id,text:'Demonstrate reviewing a setting'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');await s.runtime.extensions.background({ signal: AbortSignal.timeout(20_000), modelWorkAllowed: true, phase: 1 });
 const skill=s.store.get<any>("SELECT * FROM skills WHERE status='candidate'")!;expect(skill).toBeTruthy();expect(s.store.all('SELECT * FROM grants')).toEqual([]);
 expect(()=>s.runtime.skills.approve(skill.id,skill.version,'wrong-hash')).toThrow('changed');s.runtime.skills.approve(skill.id,skill.version,hash(skill.instructions));expect(s.store.all("SELECT * FROM skills WHERE status='active'")).toHaveLength(1);
 await s.runtime.forget(fact.id);expect(s.store.all('SELECT * FROM skills')).toEqual([]);expect(s.store.all('SELECT * FROM skill_derivations')).toEqual([]);
});
it('compacts a bounded working summary and conservatively clears only the derived context of forgetting',async()=>{
 const s=instance(),session=s.runtime.newConversation();for(let n=0;n<35;n++){const messageId=id();s.store.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',messageId,session.id,null,`human:${s.config.ownerId}`,'user',`Context ${n}`,JSON.stringify({role:'user',content:`Context ${n}`,timestamp:n}),n,n);}
 reply(s.faux,'Derived summary: unresolved goal, owner decisions and source references.');await s.runtime.compactor.compactOne();expect(s.runtime.conversation(session.id).summary).toContain('Derived summary');expect(s.store.all('SELECT * FROM context_checkpoints')).toHaveLength(1);
 const fact=s.runtime.remember('private fact','private-value') as any,reader=s.runtime.newConversation();
 s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('memory_read',{id:fact.id})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Read.')])]);
 const reading=await s.runtime.ingest({requestId:'reads-fact',conversationId:reader.id,text:'Which value?'},source);await waitFor(()=>s.runtime.run(reading.id).status==='completed');
 s.store.run("UPDATE conversations SET summary='Derived summary: private-value' WHERE id=?",reader.id);
 await s.runtime.forget(fact.id);
 expect(s.runtime.conversation(reader.id).summary).toBe('');expect(s.store.all('SELECT * FROM messages WHERE conversation_id=? AND role!=\'user\'',reader.id)).toEqual([]);
 // A conversation that never used the source keeps its own derived context.
 expect(s.runtime.conversation(session.id).summary).toContain('Derived summary');expect(s.store.all('SELECT * FROM context_checkpoints WHERE conversation_id=?',session.id)).toHaveLength(1);
});
it('owner-defined bounded workflows validate named tools, forbid recursion/builds and retain version rollback',async()=>{
 const s=instance();await expect(rpc(s.runtime,{op:'workflows.define',args:{id:'unsafe',description:'unsafe',steps:[{tool:'extension_build',args:{}}]}})).rejects.toThrow('permitted');
 const first=await rpc(s.runtime,{op:'workflows.define',args:{id:'lookup',description:'lookup',steps:[{tool:'memory_search',args:{query:'tea'}}]}}) as {version:number};expect(first.version).toBe(1);await rpc(s.runtime,{op:'workflows.define',args:{id:'lookup',description:'revision',steps:[{tool:'memory_search',args:{query:'coffee'}}]}});expect(await rpc(s.runtime,{op:'workflows.rollback',args:{id:'lookup',version:1}})).toMatchObject({version:3});
 s.faux.appendResponses([loadTools('workflow_run'),fauxAssistantMessage([fauxToolCall('workflow_run',{id:'lookup'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Workflow finished.')])]);
 const run=await s.runtime.ingest({requestId:'workflow',conversationId:s.runtime.newConversation().id,text:'Run lookup'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');expect(s.store.all("SELECT * FROM operations WHERE status='completed'")).toHaveLength(3);
 s.runtime.workflows.enable('lookup',false);expect(()=>s.runtime.workflows.read('lookup')).toThrow('disabled');
});
it('stores a third-party fact directly with original sourced attribution and no confirmation record',async()=>{
 const s=instance(),original=s.runtime.ownerEvidence('Giulia said her bicycle is red');const record=s.runtime.memory.remember({entity:'person:Giulia',kind:'fact',key:'bicycle color',value:'red',sourceId:original,eventAt:1},false);
 expect(record.status).toBe('stored');expect(record.entity).toBe('person:Giulia');expect(s.runtime.memory.list()).toMatchObject([{id:record.id}]);expect(s.runtime.memory.read(record.id).evidence).toMatchObject({id:original});expect(s.store.all('SELECT * FROM memory_confirmations')).toEqual([]);await s.runtime.forget(record.id);expect(s.runtime.memory.source(original)).toBeUndefined();
});
it('nested transactions roll back both source evidence and failed explicit mutations',()=>{
 const s=instance();expect(()=>s.runtime.remember('invalid','')).toThrow(/invalid/i);expect(s.store.all('SELECT * FROM messages')).toEqual([]);expect(s.store.all('SELECT * FROM conversations')).toEqual([]);
 expect(()=>s.store.transaction(()=>{s.runtime.remember('rolled back','value');throw new Error('rollback outer');})).toThrow('rollback outer');expect(s.store.all('SELECT * FROM memories')).toEqual([]);
});
it('forget purges source-derived executable artifacts, build prompts, approval authority and broker state',async()=>{
 const s=instance(),fact=s.runtime.remember('private fact','secret-provenance-884') as any;reply(s.faux,'Completed');const run=await s.runtime.ingest({requestId:'lineage',conversationId:s.runtime.newConversation().id,text:'secret-provenance-884'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
 s.store.run('INSERT OR IGNORE INTO run_sources(run_id,source_id) VALUES(?,?)',run.id,fact.source_id);s.store.run('INSERT INTO extension_artifacts VALUES(?,?,?,?,?,?)','hash-private','private-artifact','1.0.0','{}','{}',1);s.store.run('INSERT INTO extension_installs VALUES(?,?,NULL,1,0)','private-artifact','hash-private');s.store.run('INSERT INTO artifact_derivations VALUES(?,?)','hash-private',run.id);
 s.store.run('INSERT INTO extension_storage VALUES(?,?,?,1)','private-artifact','record','secret-provenance-884');s.store.run('INSERT INTO storage_sources VALUES(?,?,?)','private-artifact','record',fact.source_id);s.store.run('INSERT INTO grants VALUES(?,?,?,?,?,0)','grant-private','private-artifact','hash-private','storage.write','owner');s.store.run('INSERT INTO builds VALUES(?,?,?,?,?,?)','build-private','secret-provenance-884','completed','hash-private',null,1);s.store.run('INSERT INTO build_derivations VALUES(?,?)','build-private',run.id);
 await s.runtime.forget(fact.id);for(const table of ['extension_installs','extension_artifacts','extension_storage','storage_sources','grants','builds'])expect(s.store.all(`SELECT * FROM ${table}`)).toEqual([]);
});
it('media expiry retains sourced derivatives and a consistent backup without pretending raw files exist',async()=>{
 const s=instance(),session=s.runtime.newConversation(),attachment=s.runtime.media.save(Buffer.from('Archive text 319'),'text.txt','text/plain',session.id);reply(s.faux,'Read');const run=await s.runtime.ingest({requestId:'expired',conversationId:session.id,text:'Document',attachments:[attachment]},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');s.store.run('UPDATE attachments SET created_at=1');await s.runtime.media.expire();await expect(s.runtime.media.read(attachment)).rejects.toThrow('expired');expect((await s.runtime.memory.search('319'))[0]?.text).toContain('319');const snapshot=await backup(s.store);expect(snapshot.manifest.files.filter(f=>f.path.startsWith('attachments/'))).toEqual([]);
});
it('finds ephemeral lost-ack receipts and rejects changed/concurrently duplicated input',async()=>{
 const s=instance(),session=s.runtime.newConversation('volatile',true);reply(s.faux,'Only once');const request={requestId:'volatile-stable',conversationId:session.id,text:'Owner private text'};
 const [a,b]=await Promise.all([s.runtime.ingest(request,source),s.runtime.ingest(request,source)]);expect(a.id).toBe(b.id);expect(s.runtime.receipt(request.requestId,source)?.id).toBe(a.id);
 await expect(s.runtime.ingest({...request,text:'Changed text'},source)).rejects.toThrow('changed');await waitFor(()=>s.runtime.run(a.id).status==='completed');expect(s.faux.state.callCount).toBe(1);expect(s.store.all('SELECT * FROM runs')).toEqual([]);
});
it('delivers reminders while a slow background model review is in progress',async()=>{
 const s=instance();s.config.limits.backgroundIntervalMs=1000;const sourceId=s.runtime.ownerEvidence('A source to be reviewed');s.store.run("INSERT INTO reviews(source_id,status) VALUES(?,'pending')",sourceId);reply(s.faux,'Slow review output '.repeat(500));await s.runtime.start();
 const work=s.runtime.background();await waitFor(()=>s.faux.state.callCount>0);
 const job=s.runtime.scheduler.create({text:'During slow model',timezone:'Europe/Rome',at:new Date(Date.now()+60_000).toISOString(),kind:'reminder',destination:'terminal',misfire:'once'},'test');s.store.run('UPDATE schedules SET next_due=1 WHERE id=?',job.id);
 await waitFor(()=>!!s.store.get("SELECT id FROM outbox WHERE text='During slow model' AND status='sent'"),2500);await s.runtime.close();await work;
},5000);
it('enforces the notification cap even when multiple deliveries are ready in one tick',async()=>{
 const s=instance();s.config.limits.notificationsPerDay=1;for(let n=0;n<4;n++)s.runtime.scheduler.outbox(`Cap ${n}`,'terminal');await s.runtime.scheduler.tick();expect(s.store.all("SELECT * FROM outbox WHERE status='sent'")).toHaveLength(1);expect(s.store.all("SELECT * FROM outbox WHERE status='pending'")).toHaveLength(3);
});
it('upgrades a representative v1 SQLite state without losing source history',()=>{
 const root=mkdtempSync(join(tmpdir(),'pikobot-v1-'));try{const config=initialize(root,'legacy');const db=new DatabaseSync(join(root,'pikobot.sqlite'));db.exec(readFileSync(new URL('../migrations/001.sql',import.meta.url),'utf8'));db.prepare('INSERT INTO meta VALUES(?,?)').run('ownerId',config.ownerId);db.prepare('INSERT INTO meta VALUES(?,?)').run('instanceId',config.instanceId);db.exec('PRAGMA user_version=1');db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run('legacy','Legacy','terminal',JSON.stringify(config.model),'summary',1);db.close();
  const store=new Store(root,config);expect(store.get<any>('PRAGMA user_version').user_version).toBe(15);expect(store.get<any>('SELECT * FROM conversations').summary).toBe('summary');expect(store.all('SELECT * FROM skill_reviews')).toEqual([]);store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('forget purges managed old snapshots and an external old snapshot cannot resurrect deleted facts',async()=>{
 const s=instance(),fact=s.runtime.remember('private code','private-code-446') as any;const snapshot=await backup(s.store);
 const external=mkdtempSync(join(tmpdir(),'pikobot-external-backup-'));const fs=await import('node:fs/promises');await fs.cp(snapshot.path,external,{recursive:true});
 try{await s.runtime.forget(fact.id);expect((await fs.readdir(join(s.root,'backups')))).toEqual([]);await restore(s.root,external,true);const check=new Store(s.root,s.config);try{expect(check.all('SELECT * FROM memories')).toEqual([]);expect(check.all('SELECT * FROM retrieval')).toEqual([]);}finally{check.close();}}
 finally{rmSync(external,{recursive:true,force:true});}
});
