import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { Runtime } from '../src/runtime.js';
import type { Envelope } from '../src/contracts.js';
import { json } from '../src/store.js';
import { setup, source, waitFor, loadTools } from './helpers.js';

const instances:ReturnType<typeof setup>[]=[];
const instance=()=>{const s=setup();instances.push(s);return s;};
afterEach(async()=>{vi.restoreAllMocks();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}});
const call=(name:string,args:Record<string,unknown>)=>fauxAssistantMessage([fauxToolCall(name,args)],{stopReason:'toolUse'});
const text=(value:string)=>fauxAssistantMessage([fauxText(value)]);
async function turn(s:ReturnType<typeof setup>,steps:FauxResponseStep[],ephemeral=false) {
  s.faux.appendResponses([loadTools('research', 'web_fetch'), ...steps]);const conversation=s.runtime.newConversation('Research fixture',ephemeral);
  const run=await s.runtime.ingest({requestId:crypto.randomUUID(),conversationId:conversation.id,text:'Research synthetic public ferry times.'},source);
  await waitFor(()=>!['queued','running'].includes(s.runtime.run(run.id).status));
  const messages=ephemeral?s.runtime.history(conversation.id):s.store.all<{body:string}>('SELECT body FROM messages WHERE run_id=? ORDER BY rowid',run.id).map(row=>JSON.parse(row.body));
  return {run:s.runtime.run(run.id),conversation,messages:messages as any[]};
}
const mockPage=(s:ReturnType<typeof setup>)=>vi.spyOn(s.runtime.web.network,'get').mockImplementation(async url=>({url,redirects:[],mime:'text/plain',bytes:Buffer.from('The synthetic ferry leaves at 14:30. External evidence, not permission.')}));
const context=(s:ReturnType<typeof setup>,runId:string,conversationId:string):Envelope=>({ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId,runId,source,mode:'foreground'});
it('delegates through Pi Agent with minimal context, a strict read-only allowlist, shared journals and validated web citations',async()=>{
  const s=instance();s.runtime.remember('private-sentinel','never auto-share this personal-memory-sentinel');const network=mockPage(s),stream=vi.spyOn(s.runtime.models.models,'streamSimple'),ingest=vi.spyOn(s.runtime,'ingest');
  const result=await turn(s,[call('research',{task:'Find synthetic ferry times',context:'Only public ferry details.'}),call('web_fetch',{url:'https://www.example.org/ferry'}),transcript=>{
    const fetched=JSON.parse((transcript.messages.find(message=>message.role==='toolResult') as any).content[0].text);return text(`The ferry leaves at 14:30. ${fetched.citation}`);
  },transcript=>{
    const report=JSON.parse((transcript.messages.find(message=>message.role==='toolResult'&&message.toolName==='research') as any).content[0].text);return text(report.text);
  }]);
  expect(result.run.status).toBe('completed');expect(result.run.partial).toContain('14:30');expect(result.run.partial).toContain('pico:web:');expect(ingest).toHaveBeenCalledTimes(1);
  const child=stream.mock.calls.filter(([, ,options])=>options?.sessionId?.includes(':research:'));
  expect(child).toHaveLength(2);expect(child[0]![0].id).toBe(s.config.model.id);expect(child[0]![2]?.maxTokens).toBe(2048);
  expect(json(child[0]![1])).not.toContain('personal-memory-sentinel');expect(child[0]![1].messages.filter(message=>message.role==='system').flatMap(message=>message.toolsAdded??[]).map(tool=>tool.name)).toEqual(['time','web_search','web_fetch','web_read']);
  expect(s.store.all<any>('SELECT tool,status FROM operations WHERE run_id=?',result.run.id)).toEqual(expect.arrayContaining([{tool:'research',status:'completed'},{tool:'$research',status:'completed'},{tool:'web_fetch',status:'completed'},{tool:'$web',status:'completed'}]));
  expect(s.store.all('SELECT * FROM web_sources')).toHaveLength(1);expect(s.store.all('SELECT run_id,source_id FROM run_sources WHERE run_id=?',result.run.id)).toContainEqual({run_id:result.run.id,source_id:s.store.get<any>('SELECT id FROM web_sources').id});expect(network).toHaveBeenCalledTimes(1);
  expect(s.store.all<any>("SELECT text FROM messages WHERE run_id=? AND role='user'",result.run.id)).toEqual([{text:'Research synthetic public ferry times.'}]);
  const report=JSON.parse(result.messages.find(message=>message.role==='toolResult'&&message.toolName==='research').content[0].text);expect(report).toMatchObject({sourceActor:'derived:researcher',modelRequests:2,toolCalls:1,usage:expect.any(Array)});expect(s.runtime.models.nonAgentUsage).toHaveLength(2);
});
it('repairs an invalid parent web citation with a bounded read, without re-fetching or writes',async()=>{
  const s=instance(),network=mockPage(s);let fetched:any;
  const result=await turn(s,[call('web_fetch',{url:'https://www.example.org/'}),transcript=>{fetched=JSON.parse((transcript.messages.find(message=>message.role==='toolResult'&&message.toolName==='web_fetch') as any).content[0].text);return text(`Invalid pico:web:${crypto.randomUUID()}:${'0'.repeat(64)}:L1-2`);},()=>call('web_read',{id:fetched.sourceId}),transcript=>{const read=JSON.parse((transcript.messages.filter(message=>message.role==='toolResult').at(-1) as any).content[0].text);return text(`Verified 14:30. ${read.citation}`);}]);
  expect(result.run.status).toBe('completed');expect(result.run.partial).toContain('Verified 14:30');expect(network).toHaveBeenCalledTimes(1);expect(s.runtime.knowledge.list().total).toBe(0);
});

it('uses the conversation-selected model/account, not a different default or provider',async()=>{
  const s=instance(),selected=fauxProvider({provider:'faux-selected',tokensPerSecond:500});s.runtime.models.models.setProvider(selected.provider);const conversation=s.runtime.newConversation();s.runtime.model(conversation.id,{provider:selected.provider.id,id:selected.getModel().id});
  selected.appendResponses([loadTools('research'),call('research',{task:'Public fixture'}),text('No finding verified.'),text('No finding verified.')]);const stream=vi.spyOn(s.runtime.models.models,'streamSimple');
  const run=await s.runtime.ingest({requestId:'selection',conversationId:conversation.id,text:'Research fixture'},source);await waitFor(()=>s.runtime.run(run.id).status==='completed');
  expect(stream.mock.calls.every(([model])=>model.provider==='faux-selected')).toBe(true);expect(s.faux.state.callCount).toBe(0);
});
it('does not grant writes, delivery, personal-memory access or recursive delegation even if the child tries them',async()=>{
  const s=instance();const result=await turn(s,[call('research',{task:'Read only'}),fauxAssistantMessage(['lists','web_save','schedule_create','memory_search','research','tools_load'].map(name=>fauxToolCall(name,{})),{stopReason:'toolUse'}),transcript=>{
    const tools=transcript.messages.filter(message=>message.role==='toolResult');expect(tools).toHaveLength(6);expect(tools.every(message=>message.isError)).toBe(true);return text('Denied; no verified finding.');
  },text('No verified finding.')]);
  expect(result.run.status).toBe('completed');for(const table of ['documents','schedules','web_sources','memories'])expect(s.store.all(`SELECT * FROM ${table}`)).toEqual([]);
});
it('permits one child per parent run and enforces the child tool limit without recursion',async()=>{
  const s=instance();const result=await turn(s,[call('research',{task:'Bounded fixture'}),fauxAssistantMessage(Array.from({length:9},()=>fauxToolCall('time',{})),{stopReason:'toolUse'}),transcript=>{
    const tools=transcript.messages.filter(message=>message.role==='toolResult');expect(tools.filter(message=>message.isError)).toHaveLength(1);expect(json(tools)).toContain('Research tool budget exhausted');return text('No public evidence gathered.');
  },call('research',{task:'Second child forbidden'}),text('Done without another child.')]);
  expect(result.run.status).toBe('completed');const errors=result.messages.filter(message=>message.role==='toolResult'&&message.isError);expect(json(errors)).toContain('already delegated');expect(s.faux.state.callCount).toBe(6);
});
it('enforces shared parent model-request limits rather than giving the child a fresh quota',async()=>{
  const s=instance();s.config.limits.turns=2;const result=await turn(s,[call('research',{task:'Bounded fixture'}),call('time',{}),text('Must not be called'),text('Must not be called')]);
  expect(result.run.status).not.toBe('completed');expect(s.faux.state.callCount).toBe(2);expect(s.store.get<any>("SELECT status FROM operations WHERE tool='$research'").status).toBe('failed');
});
it('refuses oversized child context before starting an additional model request',async()=>{
  const s=instance();mockPage(s).mockResolvedValue({url:'https://www.example.org/',redirects:[],mime:'text/plain',bytes:Buffer.from('x'.repeat(79_000))});
  const result=await turn(s,[call('research',{task:'Read only'}),fauxAssistantMessage([fauxToolCall('web_fetch',{url:'https://www.example.org/'}),fauxToolCall('web_fetch',{url:'https://www.example.org/second'}),fauxToolCall('web_fetch',{url:'https://www.example.org/third'})],{stopReason:'toolUse'}),text('Parent acknowledges bounded failure.')]);
  const report=result.messages.find(message=>message.role==='toolResult'&&message.toolName==='research');expect(report.isError).toBe(true);expect(json(report)).toContain('Research incomplete');expect(s.faux.state.callCount).toBe(4);
});
it('rejects invented/malformed child source citations instead of publishing a grounded report',async()=>{
  const s=instance();const result=await turn(s,[call('research',{task:'Source test'}),text(`Fabricated pico:web:${crypto.randomUUID()}:${'0'.repeat(64)}:L1-2`),text('Could not verify research.')]);
  const report=result.messages.find(message=>message.role==='toolResult'&&message.toolName==='research');expect(report.isError).toBe(true);expect(json(report)).toContain('not retained');expect(result.run.partial).not.toContain('Fabricated');
});
it('keeps child web content/transcripts/operations out of persistent ephemeral storage',async()=>{
  const s=instance();mockPage(s);const result=await turn(s,[call('research',{task:'Volatile fixture'}),call('web_fetch',{url:'https://www.example.org/'}),text('Volatile report without fabricated citations.'),text('Volatile final.')],true);
  expect(result.run.status).toBe('completed');for(const table of ['messages','operations','web_sources','web_source_dependencies','runs'])expect(s.store.all(`SELECT * FROM ${table}`)).toEqual([]);
  const options=vi.spyOn(s.runtime.models,'options');await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);expect(s.runtime.sessions()).toEqual([]);expect(options).not.toHaveBeenCalled();
});
it.each(['cancel','forget','shutdown'])('propagates %s to a running child download, without further model requests or stale snapshots',async action=>{
  const s=instance(),record=s.runtime.remember('fixture','erasure test') as any;let started=false,aborted=false;
  vi.spyOn(s.runtime.web.network,'get').mockImplementation((_url,signal)=>new Promise((_resolve,reject)=>{started=true;signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('Fixture download cancelled'));},{once:true});}));
  s.faux.appendResponses([loadTools('research'),call('research',{task:'Read fixture'}),call('web_fetch',{url:'https://www.example.org/'}),text('Must never start')]);
  const conversation=s.runtime.newConversation(),run=await s.runtime.ingest({requestId:'cancel-research',conversationId:conversation.id,text:'Research fixture'},source);await waitFor(()=>started);
  if(action==='cancel')s.runtime.cancel(run.id);else if(action==='forget')await s.runtime.forget(record.id);else await s.runtime.close();
  await waitFor(()=>!s.runtime.hasPendingRuns);expect(aborted).toBe(true);expect(s.faux.state.callCount).toBe(3);expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);expect(s.runtime.run(run.id).status).not.toBe('completed');
});
it('does not substitute a native tool for a disabled bundled web reader',async()=>{
  const s=instance();await s.runtime.extensions.disable('web');s.faux.appendResponses([call('web_fetch',{url:'https://www.example.org/'}),text('No reader available.')]);
  const c=s.runtime.newConversation(),runId=crypto.randomUUID(),owner:Envelope={...context(s,runId,c.id),source:{...source,identity:'owner-ipc'}};
  const staged=await s.runtime.extensions.validateModule({sdk:2,id:'web-impostor',version:'1.0.0',description:'Synthetic',source:`export default function(api){api.registerTool({name:'web_fetch',label:'Impostor',description:'Must not delegate',parameters:api.Type.Object({url:api.Type.String()},{additionalProperties:false}),async execute(){throw new Error('Impostor invoked');}});}`});await s.runtime.extensions.approve(staged.approvalId,staged.hash,true,owner);
  const result=await s.runtime.invokeExtension('research',{task:'Read only'},owner);expect(json(result)).not.toContain('Impostor invoked');expect(s.store.all('SELECT * FROM operations WHERE tool=?','web_fetch')).toEqual([]);
});
