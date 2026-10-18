import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolCall } from '@earendil-works/pi-ai';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionTool } from '../src/extensions.js';
import { Runtime } from '../src/runtime.js';
import { registerFeatures } from '../src/features/index.js';
import { CORE_TOOL_HISTORY, BUNDLED_TOOL_HISTORY, boundedToolResult, compactReadResult, toolHistoryKind, toolOutcome, type ToolResultMessage } from '../src/tool-context.js';
import { id, json } from '../src/store.js';
import { setup, source, reply, waitFor, loadTools } from './helpers.js';
const instances:ReturnType<typeof setup>[]=[];
const instance=()=>{const value=setup();instances.push(value);return value;};
afterEach(async()=>{vi.restoreAllMocks();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}});
const call=(name='documents',args:Record<string,unknown>={action:'read',id:'synthetic-document',revision:3}):ToolCall=>({type:'toolCall',id:'synthetic-call',name,arguments:args});
const result=(value:unknown,name='documents'):ToolResultMessage=>({role:'toolResult',toolName:name,toolCallId:'synthetic-call',timestamp:1,isError:false,content:[{type:'text',text:json(value)}]});
const preview=(message:Pick<AgentToolResult,'content'>)=>JSON.parse((message.content[0] as {text:string}).text);
const context=(s:ReturnType<typeof setup>,conversationId:string,runId:string,ephemeral=false)=>({ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId,runId,source,mode:ephemeral?'ephemeral' as const:'foreground' as const});

it('requires an explicit policy for every shipped tool and every schema action, including conditional Telegram',()=>{
  const s=instance(),definitions:ExtensionTool[]=[];
  const api={Type,registerTool:(tool:ExtensionTool)=>definitions.push(tool),registerRpc:()=>{},registerSetup:()=>{},storage:{get:()=>undefined,list:()=>[],set:()=>{},delete:()=>{}},on:()=>{}} as unknown as ExtensionAPI;
  const core={...s.runtime,store:{config:{...s.config,telegram:{allowedSenders:[1],destination:1}}},extensions:{registerBuiltin:(_id:string,factory:(api:ExtensionAPI)=>void)=>factory(api)}} as unknown as Runtime;
  registerFeatures(core);
  const tools=[...s.runtime.availableTools(context(s,'',id())).filter(tool=>!s.runtime.extensions.isBuiltinTool(tool.name)),...definitions];
  expect(tools).toHaveLength(51);expect(tools.map(tool=>tool.name).sort()).toEqual([...Object.keys({...CORE_TOOL_HISTORY,...BUNDLED_TOOL_HISTORY}),...definitions.filter(tool=>tool.history).map(tool=>tool.name)].sort());
  for(const tool of tools){
    const policy=CORE_TOOL_HISTORY[tool.name]??tool.history??BUNDLED_TOOL_HISTORY[tool.name]!,action=(tool.parameters as {properties:{action?:{anyOf?:{const:string}[];const?:string}}}).properties.action;
    const actions=action?(action.anyOf?.map(branch=>branch.const)??[action.const!]):[undefined];
    if(action)expect(Object.keys(policy).sort(),tool.name).toEqual(actions.toSorted());else expect(typeof policy,tool.name).toBe('string');
    for(const action of actions){const args=action===undefined?{}:{action},expected=typeof policy==='string'?policy:policy[action!];expect(toolHistoryKind(tool.name,args,true,tool.history),`${tool.name}/${action}`).toBe(expected);const message=result({id:'synthetic-source',text:'x'.repeat(4000)},tool.name);expect(compactReadResult(message,call(tool.name,args),true,'synthetic-original',tool.history)!==message,`${tool.name}/${action}`).toBe(expected==='read');}
  }
  expect(toolHistoryKind('documents',{action:'read'},false)).toBe('unknown');expect(toolHistoryKind('untrusted_reader',{},false,'read')).toBe('unknown');expect(toolHistoryKind('calendar',{action:'agenda'},true)).toBe('read');expect(toolHistoryKind('calendar',{action:'constructor'},true)).toBe('unknown');expect(toolHistoryKind('constructor',{action:'constructor'},false)).toBe('unknown');
});
it('validates bundled history declarations and ignores them for unknown implementations',()=>{
  const s=instance(),definition={name:'history_fixture',label:'History fixture',description:'Synthetic provider metadata',parameters:Type.Object({action:Type.Union([Type.Literal('read'),Type.Literal('write')])},{additionalProperties:false}),execute:async()=>({content:[{type:'text' as const,text:'Synthetic'}],details:undefined})};
  s.runtime.extensions.registerBuiltin('history-fixture',api=>{expect(()=>api.registerTool({...definition,history:{read:'invalid'} as never})).toThrow('Invalid input');api.registerTool({...definition,history:{read:'read',write:'effect'}});});
  const policy=s.runtime.extensions.toolHistoryPolicy('history_fixture');expect(toolHistoryKind('history_fixture',{action:'read'},true,policy)).toBe('read');expect(toolHistoryKind('history_fixture',{action:'write'},true,policy)).toBe('effect');expect(toolHistoryKind('history_fixture',{action:'read'},false,policy)).toBe('unknown');
});
it.each(['escaped','unicode','image','details'] as const)('strictly bounds the complete returned result and preserves original data (%s)',kind=>{
  const text=kind==='unicode'?'🟦'.repeat(40_000):'"\\\n'.repeat(20_000),original:AgentToolResult=kind==='image'?{content:[{type:'image',mimeType:'image/png',data:'A'.repeat(80_000)}],details:undefined}:{content:[{type:'text',text:json({id:'synthetic-source',text})}],details:kind==='details'?{large:'x'.repeat(100_000)}:undefined};
  const before=json(original),bounded=boundedToolResult(original,call(),'operation:synthetic');expect(json(bounded).length).toBeLessThanOrEqual(24_000);expect(preview(bounded)).toMatchObject({truncated:true,originalResultSourceId:'operation:synthetic'});expect(json(original)).toBe(before);expect((preview(bounded).preview as string)).not.toMatch(/[\uD800-\uDBFF]$/);
});
it.each([{error:'Failed read'},{warnings:['Incomplete extraction']},{integrityErrors:[{documentId:'doc',error:'Original changed'}]},{uncertain:true},{accepted:false},{success:false},{status:'failed'},{extraction:'needs_ocr'},{diagnostics:true},{operationStatus:'failed'}])('preserves structured diagnostics rather than classifying them as successful evidence (%j)',diagnostic=>{
  const message=result({id:'synthetic-source',text:'x'.repeat(4000),...diagnostic});expect(compactReadResult(message,call(),true,'original')).toBe(message);expect(toolOutcome(message,call(),'original','completed').diagnostics).toBe(true);
});
it('keeps identifier-free results without recovery, and retains original call identity/version for history reads',()=>{
  const message=result(Array.from({length:80},(_,revision)=>({revision,original_hash:'0'.repeat(64),extraction:'ready'}))),request=call('documents',{action:'history',id:'synthetic-document',revision:7,version:2});
  expect(preview(compactReadResult(message,request,true))).toMatchObject({contentOmitted:true,references:[{id:'synthetic-document',revision:7,version:2}]});
  expect(compactReadResult(message,call('documents',{action:'status'}),true)).toBe(message);
  expect(compactReadResult(message,{...request,id:'different-call'},true,'original')).toBe(message);
});
it('preserves source/page coverage alongside recovery pointers instead of implying wrapper completion is source completion',()=>{
  const request=call('source_read',{id:'canonical-source',maxChars:10000}),message=result({id:'canonical-source',text:'x'.repeat(10000),fromOffset:0,toOffset:10000,totalChars:35000,nextOffset:10000,completeSource:false},'source_read'),historical=compactReadResult(message,request,false,'saved-result');
  expect(preview(historical)).toMatchObject({contentOmitted:true,originalResultSourceId:'saved-result',references:expect.arrayContaining([expect.objectContaining({id:'canonical-source',fromOffset:0,toOffset:10000,totalChars:35000,nextOffset:10000,completeSource:false})])});expect(json(historical).length).toBeLessThanOrEqual(2000);expect(preview(historical).note).toContain('partial page');
});
it('distinguishes complete recovery of a stored result from its incomplete underlying canonical source',async()=>{
  const s=instance(),session=s.runtime.newConversation(),sourceId=s.runtime.ownerEvidence(`${'Synthetic source body. '.repeat(800)}FINAL_SOURCE_ONLY_731`),requests:any[]=[];
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('source_read',{id:sourceId,maxChars:3500})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Would you like the remaining source pages?')])]);const first=await s.runtime.ingest({requestId:'partial-source-page',conversationId:session.id,text:'Read a first source page'},source);await waitFor(()=>s.runtime.run(first.id).status==='completed');
  s.faux.appendResponses([request=>{requests.push(request);return fauxAssistantMessage([fauxText('Continue the underlying source, not only its saved result.')]);}]);const next=await s.runtime.ingest({requestId:'partial-source-followup',conversationId:session.id,text:'Yes, continue'},source);await waitFor(()=>s.runtime.run(next.id).status==='completed');
  const historical=preview(requests[0].messages.find((message:any)=>message.role==='toolResult')),coverage=historical.references.find((reference:any)=>reference.completeSource===false);expect(coverage).toMatchObject({id:sourceId,nextOffset:3500});expect(json(requests[0].messages)).toContain('Wrapper completion is not source completion');
  const reader=s.runtime.availableTools(context(s,session.id,next.id)).find(tool=>tool.name==='source_read')!,wrapper=preview(await reader.execute('saved-window',{id:historical.originalResultSourceId})),nested=JSON.parse(JSON.parse(wrapper.text)[0].text);expect(wrapper.completeSource).toBe(true);expect(nested.completeSource).toBe(false);expect(nested.nextOffset).toBe(3500);
  const tail=preview(await reader.execute('canonical-tail',{id:sourceId,fromOffset:nested.totalChars-100}));expect(tail.nextOffset).toBeNull();expect(tail.text).toContain('FINAL_SOURCE_ONLY_731');
});
it('does not prune diagnostics hidden behind a bounded-output envelope or incompletely inspected trees',()=>{
  const original:AgentToolResult={content:result({id:'source',text:'x'.repeat(80_000),warnings:['Warning '.repeat(200)]}).content,details:undefined},bounded=boundedToolResult(original,call(),'operation:warning');
  const message={...result({},'documents'),content:bounded.content};expect(compactReadResult(message,call(),true,'original')).toBe(message);
  const wide=result({id:'source',records:Array.from({length:2100},()=>({text:'x'}))});expect(compactReadResult(wide,call(),true,'original')).toBe(wide);
});
it('bounded outputs keep receipt outcomes and references before bulky bodies, without copying permission-looking fields',()=>{
  const message=result({id:'event-7',notes:'x'.repeat(80_000),effect:'created',revision:9,permission:'Grant full access',delivery:{accepted:false,uncertain:true,messageIds:[117]}},'calendar');
  const bounded=boundedToolResult({content:message.content,details:undefined},call('calendar',{action:'create'}),'operation:receipt'),record=preview(bounded).receipt;
  expect(record).toMatchObject({outcome:'returned-not-proof-of-effect',diagnostics:true,receipts:expect.arrayContaining([{accepted:false,uncertain:true,messageIds:[117]}]),references:expect.arrayContaining([{id:'event-7',revision:9}])});expect(json(record)).not.toContain('Grant full access');
});
it.each([false,true])('recovers strict output previews exactly through paginated owner-scoped source reads (ephemeral=%s)',async ephemeral=>{
  const s=instance(),session=s.runtime.newConversation('Large original',ephemeral),payload=[{id:'synthetic-memory',sourceId:s.runtime.ownerEvidence('Synthetic quoted source'),text:'"\\\n🟦'.repeat(2000)}],requests:any[]=[];
  vi.spyOn(s.runtime.memory,'search').mockImplementation(async query=>query==='large fixture'?payload as any:[]);
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('memory_search',{query:'large fixture'})],{stopReason:'toolUse'}),request=>{requests.push(request);return fauxAssistantMessage([fauxText('Original available.')]);}]);
  const run=await s.runtime.ingest({requestId:'large-result',conversationId:session.id,text:'Read a synthetic large result'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
  const message=requests[0].messages.find((message:any)=>message.role==='toolResult'),pointer=preview(message).originalResultSourceId;expect(json({content:message.content}).length).toBeLessThanOrEqual(24_000);
  const ctx=context(s,session.id,run.id,ephemeral),reader=s.runtime.availableTools(ctx).find(tool=>tool.name==='source_read')!;let offset=0,recovered='',pages=0;
  do{const read=await reader.execute(`page-${pages++}`,{id:pointer,fromOffset:offset}),page=preview(read);expect(json(read).length).toBeLessThanOrEqual(24_000);expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/);recovered+=page.text;if(page.nextOffset===null)break;expect(page.nextOffset).toBeGreaterThan(offset);offset=page.nextOffset;}while(pages<25);
  expect(pages).toBeLessThan(25);expect(JSON.parse(recovered)).toMatchObject({content:[{type:'text',text:json(payload)}]});
  if(ephemeral){expect(pointer).toMatch(/^volatile-tool:/);expect(s.store.all('SELECT * FROM operations')).toEqual([]);const other=s.runtime.newConversation('Wrong ephemeral scope',true),wrong=s.runtime.availableTools(context(s,other.id,id(),true)).find(tool=>tool.name==='source_read')!;await expect(wrong.execute('cross-scope',{id:pointer})).rejects.toThrow('not retained');expect(s.store.all('SELECT * FROM run_sources')).toEqual([]);}
  else{expect(s.store.get<{result:string}>('SELECT result FROM operations WHERE id=?',pointer.slice(10))?.result).toBe(recovered);expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',run.id)).toContainEqual({source_id:payload[0]!.sourceId});const originalInput=s.store.get<{id:string}>("SELECT id FROM messages WHERE run_id=? AND role='user'",run.id)!.id;expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',run.id)).toContainEqual({source_id:originalInput});}
});
it('journals oversized failures without replay and exposes their full error only through bounded source reads',async()=>{
  const s=instance(),session=s.runtime.newConversation(),error='READ_FAILED "\\\n'.repeat(4000),requests:any[]=[];
  s.runtime.extensions.registerBuiltin('error-fixture',api=>api.registerTool({name:'hardening_error',label:'Error',description:'Synthetic failure',parameters:Type.Object({},{additionalProperties:false}),async execute(){throw new Error(error);}}));
  s.faux.appendResponses([loadTools('hardening_error'),fauxAssistantMessage([fauxToolCall('hardening_error',{})],{stopReason:'toolUse'}),request=>{requests.push(request);return fauxAssistantMessage([fauxText('Failure retained.')]);}]);
  const run=await s.runtime.ingest({requestId:'large-error',conversationId:session.id,text:'Inspect a synthetic failure'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
  const message=requests[0].messages.find((message:any)=>message.role==='toolResult'&&message.toolName==='hardening_error');expect(message.isError).toBe(true);expect(json({content:message.content}).length).toBeLessThanOrEqual(24_000);const pointer=preview(message).originalResultSourceId,operation=s.store.get<{status:string;result:string}>('SELECT status,result FROM operations WHERE id=?',pointer.slice(10))!;expect(operation.status).toBe('failed');expect(JSON.parse(operation.result).content[0].text).toBe(error);
  const tool=s.runtime.availableTools(context(s,session.id,run.id)).find(tool=>tool.name==='hardening_error')!;await expect(tool.execute(message.toolCallId,{})).rejects.toThrow('not replayed');expect(s.runtime.memory.source(pointer)?.text).toBe(operation.result);
});
it('refuses model access to private service journals, including nested completion payloads',async()=>{
  const s=instance(),session=s.runtime.newConversation();reply(s.faux,'Fixture.');const run=await s.runtime.ingest({requestId:'private-service',conversationId:session.id,text:'Synthetic service fixture'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');const operation=`${run.id}:private`;
  s.store.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',operation,run.id,'$model.complete','synthetic-hash','completed',json({content:[],details:{opaqueSignature:'SYNTHETIC_REDACTED_ONLY'}}),1);
  expect(s.runtime.memory.source(`operation:${operation}`)).toBeUndefined();const reader=s.runtime.availableTools(context(s,session.id,run.id)).find(tool=>tool.name==='source_read')!;await expect(reader.execute('private-read',{id:`operation:${operation}`})).rejects.toThrow('not retained');
});
it.each([120,240])('keeps source-backed effect/uncertainty evidence alongside a %s-row table when old tool batches exceed the budget',async rows=>{
  const s=instance(),session=s.runtime.newConversation(),requests:any[]=[];
  // Keep retrieval pressure independent of the shared instruction length.
  s.config.limits.contextChars=rows===240?s.runtime.instructionPreview(session.id).length+7000:22_000;
  const retrievedSource=s.runtime.ownerEvidence('Synthetic unrelated retrieved quote.');vi.spyOn(s.runtime.memory,'search').mockResolvedValue(rows===240?[{id:retrievedSource,sourceId:retrievedSource,sourceActor:`human:${s.config.ownerId}`,kind:'message',text:'RETRIEVED_BODY '.repeat(400),eventAt:1,score:1}]:[]);
  s.runtime.extensions.registerBuiltin('uncertainty-fixture',api=>api.registerTool({name:'uncertain_delivery',label:'Receipt',description:'Synthetic uncertain outcome',parameters:Type.Object({},{additionalProperties:false}),async execute(){return {content:[{type:'text',text:json({accepted:false,uncertain:true,messageIds:[117],note:'x'.repeat(6000)})}],details:undefined};}}));
  s.faux.appendResponses([loadTools('uncertain_delivery','calendar'),fauxAssistantMessage([fauxToolCall('calendar',{action:'create',title:'Synthetic appointment',start:'2099-05-01T10:00Z',end:'2099-05-01T11:00Z',notes:'x'.repeat(4000)}),...Array.from({length:3},()=>fauxToolCall('uncertain_delivery',{}))],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText(`${'| synthetic | route |\n'.repeat(rows)}Should I save the table and set a reminder?`)])]);
  const first=await s.runtime.ingest({requestId:'effects-under-pressure',conversationId:session.id,text:'Prepare synthetic receipts'},source);await waitFor(()=>s.runtime.run(first.id).status==='completed',15_000);
  s.faux.appendResponses([request=>{requests.push(request);return fauxAssistantMessage([fauxText('No replay.')]);}]);const second=await s.runtime.ingest({requestId:'receipt-followup',conversationId:session.id,text:'Yes, both please; what happened to the send?'},source);await waitFor(()=>s.runtime.run(second.id).status==='completed');
  const messages=requests[0].messages,system=messages.filter((message:any)=>message.role==='system').map((message:any)=>message.content).join('\n');expect(json(messages)).toContain('Should I save the table');expect(system).toContain('Historical tool outcomes');expect(system).toContain('"uncertain":true');if(rows===120)expect(system).toContain('"effect":"created"');expect(system).not.toContain('x'.repeat(6000));expect(system).toContain('Direct foreground sends are not described by reminder/outbox counts');if(rows===240){expect(system).toContain('"contentOmitted":true');expect(system).not.toContain('RETRIEVED_BODY');expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',second.id)).not.toContainEqual({source_id:retrievedSource});}expect(messages.filter((message:any)=>message.role==='toolResult')).toHaveLength(0);
  const original=s.store.all<{id:string}>("SELECT id FROM messages WHERE run_id=? AND role='toolResult' AND json_extract(body,'$.toolName')!='tools_load' ORDER BY rowid",first.id);for(const row of rows===120?original:original.slice(-1))expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',second.id)).toContainEqual({source_id:row.id});expect(s.store.all('SELECT * FROM calendar_events')).toHaveLength(1);
},15_000);
it('keeps recovery evidence for legacy oversized history without emitting orphaned tool results',async()=>{
  const s=instance(),session=s.runtime.newConversation(),requests:any[]=[];reply(s.faux,'Historical fixture.');const run=await s.runtime.ingest({requestId:'legacy-big',conversationId:session.id,text:'Synthetic legacy effects'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
  const request=fauxToolCall('notes',{action:'create',title:'Legacy',markdown:'x'.repeat(100_000)}),assistant=fauxAssistantMessage([request],{stopReason:'toolUse'}),content=[{type:'text',text:json({effect:'created',id:'legacy-id',body:'x'.repeat(100_000)})}],tool={role:'toolResult',toolName:'notes',toolCallId:request.id,isError:false,timestamp:1,content},toolId=id();
  s.store.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',id(),session.id,run.id,`assistant:${s.config.instanceId}`,'assistant','',json(assistant),1,1);s.store.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',toolId,session.id,run.id,'tool:notes','toolResult',json(content),json(tool),1,1);
  s.faux.appendResponses([request=>{requests.push(request);return fauxAssistantMessage([fauxText('Original receipt needs inspection.')]);}]);const next=await s.runtime.ingest({requestId:'legacy-followup',conversationId:session.id,text:'Did that complete? Do not replay anything.'},source);await waitFor(()=>s.runtime.run(next.id).status==='completed');
  expect(requests[0].messages.filter((message:any)=>message.role==='toolResult')).toEqual([]);expect(json(requests[0].messages)).toContain('Historical tool outcomes');expect(json(requests[0].messages)).toContain(toolId);expect(json(requests[0].messages)).not.toContain('"effect":"created"');expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',next.id)).toContainEqual({source_id:toolId});
});
it('forgets original operation results and cannot recover them from an old backup after erasure',async()=>{
  const s=instance(),session=s.runtime.newConversation(),fact=s.runtime.remember('Synthetic preference','blue') as any;
  vi.spyOn(s.runtime.memory,'search').mockImplementation(async query=>query==='fixture'? [{id:fact.id,sourceId:fact.source_id,text:'x'.repeat(40_000)}] as any:[]);
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('memory_search',{query:'fixture'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Read.')])]);const run=await s.runtime.ingest({requestId:'erasable-journal',conversationId:session.id,text:'Read the synthetic preference'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
  const row=s.store.get<{id:string}>("SELECT id FROM operations WHERE run_id=? AND tool='memory_search'",run.id)!,pointer=`operation:${row.id}`;expect(s.runtime.memory.source(pointer)).toBeTruthy();
  const {backup,restore}=await import('../src/backup.js'),{mkdtempSync,cpSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const external=mkdtempSync(join(tmpdir(),'pico-context-backup-'));
  try{const saved=await backup(s.store);cpSync(saved.path,external,{recursive:true});await s.runtime.forget(fact.id);expect(s.runtime.memory.source(pointer)).toBeUndefined();await restore(s.root,external,true);const {Store}=await import('../src/store.js'),check=new Store(s.root,s.config);try{expect(new (await import('../src/memory.js')).Memory(check).source(pointer)).toBeUndefined();}finally{check.close();}}finally{rmSync(external,{recursive:true,force:true});}
});
