import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setup } from './helpers.js';
import { id, json } from '../src/store.js';
const instances:ReturnType<typeof setup>[]=[];
const instance=()=>{const value=setup();instances.push(value);return value;};
afterEach(async()=>{vi.restoreAllMocks();for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}});
function exchanges(s:ReturnType<typeof setup>,count=5,tools=3,textSize=20){
  const session=s.runtime.newConversation('Summary boundaries');
  for(let turn=0;turn<count;turn++){
    const runId=id();s.store.run("INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,'{}','completed',1,1)",runId,session.id,`fixture-${turn}`);
    const add=(role:string,body:unknown,text:string)=>s.store.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',id(),session.id,runId,role==='user'?`human:${s.config.ownerId}`:role==='assistant'?`assistant:${s.config.instanceId}`:'tool:fixture',role,text,json(body),1,1);
    add('user',{role:'user',content:`Owner question ${turn}`,timestamp:1},`Owner question ${turn}`);
    for(let index=0;index<tools;index++){
      const request=fauxToolCall('time',{});add('assistant',fauxAssistantMessage([request],{stopReason:'toolUse'}),'');
      const content=[{type:'text',text:json({id:'fixture-source',text:'x'.repeat(textSize),accepted:false,uncertain:true})}];add('toolResult',{role:'toolResult',toolName:'time',toolCallId:request.id,isError:false,content,timestamp:1},json(content));
    }
    add('assistant',fauxAssistantMessage([fauxText(`Final answer ${turn}; should I do both?`)]),`Final answer ${turn}; should I do both?`);
  }
  return session;
}
it('summarizes only whole exchanges and leaves the final question paired with its tool-heavy turn',async()=>{
  const s=instance(),session=exchanges(s),requests:any[]=[];
  vi.spyOn(s.runtime.models,'complete').mockImplementation(async request=>{requests.push(request);return fauxAssistantMessage([fauxText('Derived working summary.')]);});
  await s.runtime.compactor.compactOne();const payload=JSON.parse(requests[0].messages[0].content),checkpoint=s.store.get<{through:number}>('SELECT through FROM context_checkpoints WHERE conversation_id=?',session.id)!;
  expect(payload.batch).toHaveLength(16);expect(payload.batch.at(-1).text).toContain('Final answer 1');expect(s.store.get<{role:string}>('SELECT role FROM messages WHERE rowid=?',checkpoint.through+1)?.role).toBe('user');expect(s.store.all('SELECT * FROM messages')).toHaveLength(40);
  expect(json(payload)).toContain('"uncertain":true');expect(json(payload)).toContain('"runStatus":"completed"');expect(requests[0].systemPrompt).toContain('not an accepted effect');
});
it('summarizes a single oversized completed exchange together with bounded input, without splitting calls/results',async()=>{
  const s=instance();s.config.limits.contextChars=22_000;const session=exchanges(s,1,20,4000),requests:any[]=[];
  vi.spyOn(s.runtime.models,'complete').mockImplementation(async request=>{requests.push(request);return fauxAssistantMessage([fauxText('Derived large-exchange summary.')]);});
  await s.runtime.compactor.compactOne();expect(requests).toHaveLength(1);const request=requests[0],payload=JSON.parse(request.messages[0].content);expect(payload.batch).toHaveLength(42);expect(payload.batch.at(-1).text).toContain('Final answer 0');expect(request.systemPrompt.length+request.messages[0].content.length).toBeLessThanOrEqual(22_000);expect(s.store.get<{through:number}>('SELECT through FROM context_checkpoints WHERE conversation_id=?',session.id)?.through).toBe(42);expect(payload.batch.some((row:any)=>!row.textComplete)).toBe(true);
});
it.each([false,true])('does not resurrect erased context or checkpoints when summary generation settles after erasure (failure=%s)',async failure=>{
  const s=instance(),session=exchanges(s);
  vi.spyOn(s.runtime.models,'complete').mockImplementation(async()=>{s.store.run("DELETE FROM messages WHERE role!='user'");s.store.run("UPDATE conversations SET summary='' WHERE id=?",session.id);s.store.run('DELETE FROM context_checkpoints');if(failure)throw new Error('Mocked failure after erasure');return fauxAssistantMessage([fauxText('STALE_ERASED_SUMMARY')]);});
  await s.runtime.compactor.compactOne();expect(s.runtime.conversation(session.id).summary).toBe('');expect(s.store.all('SELECT * FROM context_checkpoints')).toEqual([]);
});
it('defers a summary commit if a new run has become active while its model request was pending',async()=>{
  const s=instance(),session=exchanges(s);
  vi.spyOn(s.runtime.models,'complete').mockImplementation(async()=>{s.store.run("INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,'{}','queued',1,1)",id(),session.id,'new-input');return fauxAssistantMessage([fauxText('Do not commit while busy.')]);});
  await s.runtime.compactor.compactOne();expect(s.runtime.conversation(session.id).summary).toBe('');expect(s.store.all('SELECT * FROM context_checkpoints')).toEqual([]);
});
it('rejects a stale concurrent summary without overwriting a newer checkpoint',async()=>{
  const s=instance(),session=exchanges(s);let calls=0;
  vi.spyOn(s.runtime.models,'complete').mockImplementation(async()=>{const current=++calls;if(current===1)await s.runtime.compactor.compactOne();return fauxAssistantMessage([fauxText(current===2?'Newer summary.':'Older summary.')]);});
  await s.runtime.compactor.compactOne();expect(calls).toBe(2);expect(s.runtime.conversation(session.id).summary).toBe('Newer summary.');expect(s.store.get<{through:number}>('SELECT through FROM context_checkpoints WHERE conversation_id=?',session.id)?.through).toBe(16);
});
it('keeps incomplete single exchanges out of the checkpoint and respects abort without scheduling stale retries',async()=>{
  const s=instance(),session=exchanges(s,1,20);s.store.run("UPDATE runs SET status='queued' WHERE conversation_id=?",session.id);const complete=vi.spyOn(s.runtime.models,'complete');await s.runtime.compactor.compactOne();expect(complete).not.toHaveBeenCalled();s.store.run("UPDATE runs SET status='completed' WHERE conversation_id=?",session.id);
  const controller=new AbortController();complete.mockImplementation(async()=>{controller.abort();return fauxAssistantMessage([fauxText('Aborted summary.')]);});await s.runtime.compactor.compactOne(controller.signal);expect(s.store.all('SELECT * FROM context_checkpoints')).toEqual([]);
});
