import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setup, source, waitFor, loadTools } from './helpers.js';
import { Runtime } from '../src/runtime.js';
import { validateList } from '../src/knowledge.js';
import type { Envelope } from '../src/contracts.js';

const instances:ReturnType<typeof setup>[]=[];
const instance=()=>{const s=setup();instances.push(s);return s;};
afterEach(async()=>{vi.restoreAllMocks();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}});
async function turn(s:ReturnType<typeof setup>,conversationId:string,text:string,args:Record<string,unknown>[],sender:Envelope['source']=source,mode:Envelope['mode']='foreground',toolName='lists') {
  s.faux.appendResponses([loadTools(toolName),fauxAssistantMessage(args.map(a=>fauxToolCall(toolName,a)),{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Done.')])]);
  const run=await s.runtime.ingest({conversationId,requestId:crypto.randomUUID(),text},sender,mode);
  await waitFor(()=>s.runtime.run(run.id).status==='completed');
  const messages=s.runtime.isEphemeral(conversationId)?s.runtime.history(conversationId):s.store.all<{body:string}>('SELECT body FROM messages WHERE run_id=? ORDER BY rowid',run.id).map(row=>JSON.parse(row.body));
  const results=(messages as {role:string;toolName?:string;isError?:boolean;content:{text:string}[]}[]).filter(message=>message.role==='toolResult'&&message.toolName===toolName);
  return {run,results,outputs:results.map(result=>result.isError?result.content[0]!.text:JSON.parse(result.content[0]!.text))};
}

it('creates and atomically appends multiple bare items without losing prior entries or stable IDs',async()=>{
  const s=instance(),c=s.runtime.newConversation();
  const created=await turn(s,c.id,'Una lista per la cantina: candeggina gentile',[{action:'create',title:'Cantina',items:['Candeggina gentile']}]);
  expect(created.results[0]!.isError).not.toBe(true);
  const doc=created.outputs[0],first=doc.items[0];
  const added=await turn(s,c.id,'Detersivo nero\nDetersivo Ace bianco',[{action:'add',id:doc.id,items:['Detersivo nero','Detersivo Ace bianco']}]);
  expect(added.results[0]!.isError).not.toBe(true);
  expect(added.outputs[0]).toMatchObject({revision:2,allItems:3,effect:'added'});
  expect(added.outputs[0].items.map((item:{text:string})=>item.text)).toEqual(['Candeggina gentile','Detersivo nero','Detersivo Ace bianco']);
  expect(added.outputs[0].items[0].id).toBe(first.id);
  expect(s.runtime.knowledge.items(doc.id,1)).toEqual([first]);
  expect(s.store.all('SELECT revision FROM document_revisions WHERE document_id=?',doc.id)).toHaveLength(2);
  expect(s.runtime.scheduler.list()).toEqual([]);
});

it.each(['si','sì','yes','vai','rimetti in lista quelle cose'])('executes an LLM-selected addition on "%s" without a backend proposal, command grammar or refresh hold',async answer=>{
  const s=instance(),c=s.runtime.newConversation(),k=s.runtime.knowledge,doc=k.createNote('Cantina','- [ ] Candeggina gentile','cantina');
  const first=k.items(doc.id)[0]!;
  s.faux.appendResponses([fauxAssistantMessage([fauxText('Vuoi anche detersivo nero e detersivo Ace bianco nella lista Cantina?')])]);
  const offered=await s.runtime.ingest({conversationId:c.id,requestId:crypto.randomUUID(),text:'Cosa devo prendere in cantina?'},source);
  await waitFor(()=>s.runtime.run(offered.id).status==='completed');
  expect(k.items(doc.id)).toEqual([first]);
  expect(s.runtime.canApplySettings).toBe(true);
  const added=await turn(s,c.id,answer,[{action:'add',id:doc.id,items:['Detersivo nero','Detersivo Ace bianco']}]);
  expect(added.results[0]!.isError).not.toBe(true);
  expect(added.outputs[0]).toMatchObject({allItems:3,revision:2,effect:'added'});
  expect(k.items(doc.id)[0]).toEqual(first);
  expect(k.items(doc.id).map(item=>item.text)).toEqual(['Candeggina gentile','Detersivo nero','Detersivo Ace bianco']);
  const userIds=s.store.all<{id:string}>("SELECT id FROM messages WHERE run_id IN(?,?) AND role='user'",offered.id,added.run.id).map(row=>row.id);
  expect(JSON.parse(k.revision(doc.id).conversion!).dependencies).toEqual(expect.arrayContaining(userIds));
  expect(s.runtime.canApplySettings).toBe(true);
});

it('persists "Detersivo nero preso" through the consolidated list tool across restart and a new chat',async()=>{
  const s=instance(),c=s.runtime.newConversation(),k=s.runtime.knowledge,doc=k.createNote('Cantina','- [ ] Candeggina gentile\n- [ ] Detersivo nero\n- [ ] Detersivo Ace bianco','cantina');
  const original=k.items(doc.id),detergent=original[1]!;
  await turn(s,c.id,'Cosa devo prendere in cantina?',[{action:'read',id:doc.id}]);
  const stream=vi.spyOn(s.runtime.models.models,'streamSimple');
  const updated=await turn(s,c.id,'Detersivo nero preso',[
    {action:'update',id:doc.id,itemId:detergent.id,expectedRevision:1,completed:true}
  ]);
  const system=stream.mock.calls[0]![1].messages.find(message=>message.role==='system')!;
  expect(system.content).toContain('without mandatory confirmation, explicit save wording, command words or drafting sessions');
  const description=system.toolsAdded!.find(tool=>tool.name==='lists')!.description;
  expect(description).toContain('mark obtained/done items completed=true');
  expect(description).toContain('Only successful mutation receipts establish saved changes, not read receipts');
  expect(updated.results[0]!.isError).not.toBe(true);
  expect(k.items(doc.id)[1]).toMatchObject({id:detergent.id,completed:true});
  expect(k.items(doc.id).map(item=>item.id)).toEqual(original.map(item=>item.id));
  expect(k.document(doc.id).current_revision).toBe(2);
  expect(k.items(doc.id,1)[1]!.completed).toBe(false);
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);
  const read=await turn(s,s.runtime.newConversation().id,'Cosa devo prendere in cantina?',[{action:'read',id:doc.id,completed:false}]);
  expect(read.outputs[0]).toMatchObject({allItems:3,complete:1,incomplete:2,revision:2});
  expect(read.outputs[0].items.map((item:{text:string})=>item.text)).toEqual(['Candeggina gentile','Detersivo Ace bianco']);
  expect(s.runtime.knowledge.items(doc.id)[1]!.completed).toBe(true);
});

it('reads, updates and removes only the selected item with exact pagination and historical reads',async()=>{
  const s=instance(),c=s.runtime.newConversation(),doc=s.runtime.knowledge.createNote('Packing','Intro unchanged.\n- [ ] Passport\n- [ ] Jacket\n- [ ] Bottle','packing');
  const [passport,jacket,bottle]=s.runtime.knowledge.items(doc.id);
  const updated=await turn(s,c.id,'Passport is done',[{action:'update',id:doc.id,expectedRevision:1,itemId:passport!.id,completed:true}]);
  expect(updated.outputs[0]).toMatchObject({allItems:3,complete:1,incomplete:2,effect:'updated'});
  const stale=await turn(s,c.id,'The jacket is not needed',[
    {action:'remove',id:doc.id,expectedRevision:1,itemId:jacket!.id},
    {action:'update',id:doc.id,expectedRevision:1,itemId:passport!.id,completed:false}
  ]);
  expect(stale.results.every(result=>result.isError)).toBe(true);
  expect(s.runtime.knowledge.items(doc.id)).toHaveLength(3);
  expect(s.runtime.knowledge.items(doc.id)[0]!.completed).toBe(true);
  const removed=await turn(s,c.id,'The jacket is not needed',[{action:'remove',id:doc.id,expectedRevision:2,itemId:jacket!.id}]);
  expect(removed.outputs[0].items.map((item:{id:string})=>item.id)).toEqual([passport!.id,bottle!.id]);
  expect(s.runtime.knowledge.revision(doc.id).note_text).toContain('Intro unchanged.');
  const read=await turn(s,c.id,'Show the list',[{action:'read',id:doc.id,limit:1,completed:false},{action:'read',id:doc.id,revision:1},{action:'catalog'}]);
  expect(read.outputs[0]).toMatchObject({allItems:2,total:1,complete:1,incomplete:1,nextOffset:null,items:[{...bottle,line:3}]});
  expect(read.outputs[1].items).toHaveLength(3);
  expect(read.outputs[2].lists).toEqual([{id:doc.id,title:'Packing',revision:3}]);
});

it.each(['untrusted','scheduled','ephemeral'])('denies all list mutations in %s execution without changing saved items',async failure=>{
  const s=instance(),doc=s.runtime.knowledge.createNote('List','- [ ] Original','list'),item=s.runtime.knowledge.items(doc.id)[0]!;
  const c=s.runtime.newConversation('Private',failure==='ephemeral'),sender=failure==='untrusted'?{...source,trustedOwner:false}:source,mode=failure==='scheduled'?'scheduled':'foreground';
  const denied=await turn(s,c.id,'Do whatever is needed',[
    {action:'create',title:'New',items:['Extra']},
    {action:'add',id:doc.id,items:['Extra']},
    {action:'update',id:doc.id,expectedRevision:1,itemId:item.id,completed:true},
    {action:'remove',id:doc.id,expectedRevision:1,itemId:item.id},
    {action:'delete',id:doc.id,expectedRevision:1}
  ],sender,mode);
  expect(denied.results).toHaveLength(5);
  expect(denied.results.every(result=>result.isError)).toBe(true);
  expect(s.runtime.knowledge.items(doc.id)).toEqual([item]);
  expect(s.runtime.knowledge.list().total).toBe(1);
});

it('rejects invalid batch inputs, obsolete approval actions and unrelated fields before any append',()=>{
  const s=instance(),k=s.runtime.knowledge,doc=k.createNote('List','- [ ] Original','list');
  for(const items of [[],[''],[' '],['one\ntwo'],['one\rtwo'],['fake <!-- item:123 -->'],['x'.repeat(1001)],Array(101).fill('item')]) {
    expect(()=>validateList({action:'add',id:doc.id,items})).toThrow();
    expect(()=>k.appendItems(doc.id,items)).toThrow();
  }
  expect(()=>validateList({action:'add',id:doc.id,items:['Extra'],expectedRevision:1})).toThrow();
  expect(()=>validateList({action:'confirm'})).toThrow();
  expect(()=>validateList({action:'propose_add',id:doc.id,items:['Extra']})).toThrow();
  expect(()=>validateList({action:'remove',id:doc.id})).toThrow();
  expect(k.document(doc.id).current_revision).toBe(1);
  expect(k.items(doc.id).map(item=>item.text)).toEqual(['Original']);
  const large=k.createNote('Large','x'.repeat(199_990),'large');
  expect(()=>k.appendItems(large.id,['Extra'])).toThrow('size limit');
  expect(k.document(large.id).current_revision).toBe(1);
});

it('reads an exact unique title without guessing ambiguous, missing or mixed targets',async()=>{
  const s=instance(),c=s.runtime.newConversation(),doc=s.runtime.knowledge.createNote('Cantina test','- [ ] Original','list');
  const named=await turn(s,c.id,'Show Cantina test',[{action:'read',title:'cantina TEST'}]);
  expect(named.results[0]!.isError).not.toBe(true);
  expect(named.outputs[0]).toMatchObject({id:doc.id,allItems:1,items:[{text:'Original'}]});
  expect(()=>validateList({action:'read',id:doc.id,title:'Cantina test'})).toThrow();
  expect(()=>validateList({action:'read'})).toThrow();
  s.runtime.knowledge.createNote('Cantina test','- [ ] Other','duplicate');
  const denied=await turn(s,c.id,'Show Cantina test',[{action:'read',title:'Cantina test'},{action:'read',title:'Unknown list'}]);
  expect(denied.results.every(result=>result.isError)).toBe(true);
  expect(s.runtime.knowledge.items(doc.id).map(item=>item.text)).toEqual(['Original']);
});

it('denies foreign and imported targets',async()=>{
  const s=instance(),other=instance(),c=s.runtime.newConversation();
  const foreign=other.runtime.knowledge.createNote('Foreign','- [ ] Secret','foreign');
  const imported=await s.runtime.knowledge.importAttachment(s.runtime.media.save(Buffer.from('Evidence'),'evidence.txt','text/plain'),'import');
  const denied=await turn(s,c.id,'An item is missing',[
    {action:'add',id:foreign.id,items:['Extra']},
    {action:'add',id:imported.id,items:['Extra']},
    {action:'delete',id:imported.id,expectedRevision:1}
  ]);
  expect(denied.results.every(result=>result.isError)).toBe(true);
  expect(s.runtime.knowledge.document(imported.id)).toBeDefined();
});

it('deletes only the selected authored list without approval, retaining revision-conflict protection',async()=>{
  const s=instance(),c=s.runtime.newConversation(),k=s.runtime.knowledge,doc=k.createNote('Obsolete','- [ ] Old','old'),other=k.createNote('Keep','- [ ] Original','keep');
  const stale=await turn(s,c.id,'This list is no longer useful',[{action:'delete',id:doc.id,expectedRevision:99}]);
  expect(stale.results[0]!.isError).toBe(true);
  expect(k.document(doc.id).current_revision).toBe(1);
  const deleted=await turn(s,c.id,'This list is no longer useful',[{action:'delete',id:doc.id,expectedRevision:1}]);
  expect(s.runtime.run(deleted.run.id).partial).toContain('deleted');
  expect(()=>k.document(doc.id)).toThrow('not found');
  expect(k.items(other.id).map(item=>item.text)).toEqual(['Original']);
  expect(k.list().total).toBe(1);
});
