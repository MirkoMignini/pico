import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { backup, exportData, restore } from '../src/backup.js';
import { rpc } from '../src/daemon.js';
import { timeResult, instant, dayRange } from '../src/time.js';
import { nextDue } from '../src/scheduler.js';
import type { Envelope } from '../src/contracts.js';
import { setup, source, waitFor, loadTools } from './helpers.js';

const instances:ReturnType<typeof setup>[] = [], directories:string[]=[];
const instance = () => { const s=setup(); instances.push(s); return s; };
afterEach(async()=>{for(const s of instances.splice(0)){await s.runtime.close();s.store.close();rmSync(s.root,{recursive:true,force:true});}for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
const owner = (s:ReturnType<typeof setup>):Envelope => ({ownerId:s.config.ownerId,instanceId:s.config.instanceId,conversationId:'',runId:crypto.randomUUID(),source:{...source,identity:'owner-ipc'},mode:'foreground'});
const definition = () => ({action:'create',title:'Dentist',start:'2099-10-15T10:00:00+02:00',end:'2099-10-15T11:00:00+02:00',timezone:'Europe/Rome',location:'Clinic',notes:'Synthetic appointment'});
async function invoke(s:ReturnType<typeof setup>,args:Record<string,unknown>):Promise<any> {const result=await s.runtime.invokeExtension('calendar',args,owner(s));return JSON.parse((result.content[0] as {text:string}).text);}
async function turn(s:ReturnType<typeof setup>,args:Record<string,unknown>,mode:Envelope['mode']='foreground',trustedOwner=true) {
  const conversation=s.runtime.newConversation('Synthetic planning',mode==='ephemeral');
  s.faux.appendResponses([loadTools('calendar'),fauxAssistantMessage([fauxToolCall('calendar',args)],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Synthetic response')])]);
  const run=await s.runtime.ingest({requestId:crypto.randomUUID(),conversationId:conversation.id,text:'Add a synthetic dentist appointment'}, {...source,trustedOwner},mode);
  await waitFor(()=>s.runtime.run(run.id).status==='completed');
  const messages=mode==='ephemeral'?s.runtime.history(conversation.id):s.store.all<{body:string}>('SELECT body FROM messages WHERE run_id=?',run.id).map(row=>JSON.parse(row.body));
  return {run,result:messages.find((m:any)=>m.role==='toolResult'&&m.toolName==='calendar') as any};
}

it.each([
  ['Europe/Rome','2026-10-15T10:00','2026-10-15T08:00:00.000Z'],
  ['Asia/Kathmandu','2026-10-15T10:00','2026-10-15T04:15:00.000Z'],
  ['Australia/Lord_Howe','2026-07-15T10:00','2026-07-14T23:30:00.000Z'],
  ['America/New_York','2026-01-15T10:00:00.123','2026-01-15T15:00:00.123Z']
])('resolves unambiguous local times precisely in %s', (timezone,at,expected)=>{
  const result=timeResult({at,timezone},'UTC');expect(result.utc).toBe(expected);expect(instant(result.isoLocal)).toBe(instant(result.utc));
});
it.each([
  ['Europe/Rome','2026-03-29T02:30'],['Europe/Rome','2026-10-25T02:30'],
  ['America/New_York','2026-03-08T02:30'],['America/New_York','2026-11-01T01:30'],
  ['Australia/Lord_Howe','2026-04-05T01:45'],['Australia/Lord_Howe','2026-10-04T02:15']
])('rejects missing or ambiguous DST wall time: %s %s',(timezone,at)=>expect(()=>timeResult({at,timezone},'UTC')).toThrow(/Ambiguous|does not exist/));
it.each(['2099-02-29T10:00:00Z','2026-02-30T10:00Z','2026-04-31T10:00Z','2026-01-01T24:00Z','2026-01-01T10:60Z','2026-01-01T10:00:60Z','2026-01-01T10:00+24:00','not-a-date','2026-01-01'])('rejects invalid datetime instead of silently rolling it forward: %s',at=>expect(()=>instant(at)).toThrow());
it('adds elapsed minutes across DST and rejects malformed/unbounded time inputs',()=>{
  expect(timeResult({at:'2026-03-29T01:30:00+01:00',timezone:'Europe/Rome',addMinutes:60},'UTC').isoLocal).toBe('2026-03-29T03:30:00.000+02:00');
  expect(timeResult({at:'2026-10-25T02:30:00+02:00',timezone:'Europe/Rome',addMinutes:60},'UTC').isoLocal).toBe('2026-10-25T02:30:00.000+01:00');
  for(const input of [{at:''},{addMinutes:1.5},{addMinutes:525601},{timezone:'invalid'},{ownerId:'foreign'}])expect(()=>timeResult(input,'UTC')).toThrow();
  expect(()=>timeResult({at:'9999-12-31T23:59Z',addMinutes:1},'UTC')).toThrow('supported years');
  expect(()=>instant('0000-01-01T00:00+14:00')).toThrow('supported years');
  expect(timeResult({},'UTC',1000)).toMatchObject({utc:'1970-01-01T00:00:01.000Z',epochMs:1000});
  expect(()=>nextDue({text:'Bad date',timezone:'UTC',at:'2099-02-31T10:00:00Z',kind:'reminder',destination:'terminal',misfire:'once'},Date.now())).toThrow('calendar date');
});
it('resolves today/tomorrow clocks from the local date even when UTC is still yesterday',()=>{
  const now=Date.parse('2026-10-11T23:55Z');
  expect(timeResult({timezone:'Europe/Rome'},'UTC',now)).toMatchObject({dateLocal:'2026-10-12',tomorrowLocalDate:'2026-10-13'});
  expect(timeResult({day:'tomorrow',clock:'09:00',timezone:'Europe/Rome'},'UTC',now).isoLocal).toBe('2026-10-13T09:00:00.000+02:00');
  expect(timeResult({day:'today',clock:'09:00',addMinutes:60,timezone:'Europe/Rome'},'UTC',now).isoLocal).toBe('2026-10-12T10:00:00.000+02:00');
  expect(timeResult({day:'tomorrow',clock:'09:00',timezone:'America/Chicago'},'UTC',now).isoLocal).toBe('2026-10-12T09:00:00.000-05:00');
  for(const args of [{clock:'09:00'},{day:'today',at:'2026-10-12T09:00Z'},{day:'today',clock:'24:00'},{day:'week'},{day:'today',clock:'09:30x123'}])expect(()=>timeResult(args,'UTC',now)).toThrow();
  expect(()=>timeResult({day:'tomorrow',clock:'02:30'},'Europe/Rome',Date.parse('2026-03-28T12:00Z'))).toThrow('does not exist');
  expect(()=>timeResult({day:'tomorrow',clock:'02:30'},'Europe/Rome',Date.parse('2026-10-24T12:00Z'))).toThrow('Ambiguous');
});
it.each([['2026-03-29',23],['2026-10-25',25]])('uses local-day boundaries, not fixed 24-hour blocks: %s',(date,hours)=>{
  const range=dayRange(date,'today','Europe/Rome');expect(range.to-range.from).toBe(Number(hours)*3600_000);
  const week=dayRange(date,'week','Europe/Rome');expect(week.to-week.from).toBe((Number(hours)+6*24)*3600_000);
});
it('rejects invalid/skipped agenda dates and resolves tomorrow in the owner timezone',()=>{
  expect(()=>dayRange('2026-02-31','today','Europe/Rome')).toThrow();expect(()=>dayRange('2011-12-30','today','Pacific/Apia')).toThrow();expect(()=>dayRange('2026-10-15','tomorrow','UTC')).toThrow();
  expect(new Date(dayRange(undefined,'tomorrow','Europe/Rome',Date.parse('2026-10-15T22:30Z')).from).toISOString()).toBe('2026-10-16T22:00:00.000Z');
});
it('creates, reads, partially updates and deletes revision-checked appointments without losing other fields',async()=>{
  const s=instance(),created=await invoke(s,definition());expect(created).toMatchObject({title:'Dentist',start:'2099-10-15T08:00:00.000Z',revision:1,effect:'created',conflicts:{total:0}});
  const updated=await invoke(s,{action:'update',id:created.id,expectedRevision:1,title:'Dentist checkup'});
  expect(updated).toMatchObject({title:'Dentist checkup',location:'Clinic',notes:'Synthetic appointment',revision:2,start:created.start,end:created.end});
  await expect(invoke(s,{action:'delete',id:created.id,expectedRevision:1})).rejects.toThrow('revision conflict');
  const read=await invoke(s,{action:'read',id:created.id});expect(read.title).toBe('Dentist checkup');
  await invoke(s,{action:'delete',id:created.id,expectedRevision:2});expect(s.store.all('SELECT * FROM calendar_events')).toEqual([]);
  await expect(invoke(s,{action:'read',id:created.id})).rejects.toThrow('not found');
});
it('reports overlapping conflicts, permits adjacent appointments, and paginates title-filtered intervals',async()=>{
  const s=instance(),first=await invoke(s,definition()),overlap=await invoke(s,{...definition(),title:'Meeting',start:'2099-10-15T10:30+02:00',end:'2099-10-15T11:30+02:00'});
  expect(overlap.conflicts).toEqual({total:1,ids:[first.id],truncated:false});
  const adjacent=await invoke(s,{...definition(),title:'Lunch',start:'2099-10-15T11:30+02:00',end:'2099-10-15T12:00+02:00'});expect(adjacent.conflicts.total).toBe(0);
  const query={action:'list',from:'2099-10-15T00:00Z',to:'2099-10-16T00:00Z',limit:1};
  const page=await invoke(s,query);expect(page).toMatchObject({total:3,offset:0,nextOffset:1});
  expect((await invoke(s,{...query,offset:1})).events[0].id).toBe(overlap.id);
  expect((await invoke(s,{...query,query:'dentist'})).events[0].id).toBe(first.id);
});
it.each(['ephemeral','scheduled','review','untrusted'])('denies calendar mutations in %s work',async mode=>{
  const s=instance(),created=await invoke(s,definition()),before=s.store.all('SELECT * FROM calendar_events');
  for(const args of [definition(),{action:'update',id:created.id,expectedRevision:1,title:'Denied'},{action:'delete',id:created.id,expectedRevision:1}]){
    const denied=await turn(s,args,mode==='untrusted'?'foreground':mode as Envelope['mode'],mode!=='untrusted');expect(denied.result.isError).toBe(true);
  }
  expect(s.store.all('SELECT * FROM calendar_events')).toEqual(before);
});
it('citation repair cannot create, change or delete calendar state',async()=>{
  const s=instance(),event=await invoke(s,definition()),before=s.store.all('SELECT * FROM calendar_events');
  for(const args of [definition(),{action:'update',id:event.id,expectedRevision:1,title:'Denied repair'},{action:'delete',id:event.id,expectedRevision:1}]){
    const conversation=s.runtime.newConversation('Synthetic citation repair');
    s.faux.appendResponses([fauxAssistantMessage([fauxText(`Invalid pico:web:${crypto.randomUUID()}:${'0'.repeat(64)}:L1-2`)]),fauxAssistantMessage([fauxToolCall('calendar',args)],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('No grounded evidence available.')])]);
    const run=await s.runtime.ingest({requestId:crypto.randomUUID(),conversationId:conversation.id,text:'Read planning evidence'},source);
    await waitFor(()=>s.runtime.run(run.id).status==='completed');
    const result=s.store.all<{body:string}>("SELECT body FROM messages WHERE run_id=? AND role='toolResult'",run.id).map(row=>JSON.parse(row.body))[0];expect(result.isError).toBe(true);
  }
  expect(s.store.all('SELECT * FROM calendar_events')).toEqual(before);
});
it('rejects forged ownership, unknown fields, missing definitions and invalid event boundaries atomically',async()=>{
  const s=instance();
  await expect(s.runtime.invokeExtension('calendar',definition(),{...owner(s),ownerId:'foreign'})).rejects.toThrow('Trusted retained owner');
  for(const args of [{...definition(),ownerId:'foreign'},{...definition(),start:'2099-10-15T10:00'},{...definition(),end:'2099-10-15T09:00+02:00'},{...definition(),end:'2101-10-15T10:00Z'},{...definition(),timezone:'invalid'},{...definition(),title:' '},{action:'create',title:'Missing'}])await expect(invoke(s,args)).rejects.toThrow();
  const created=await invoke(s,definition()),before=s.store.all('SELECT * FROM calendar_events');
  await expect(invoke(s,{action:'update',id:created.id,expectedRevision:1})).rejects.toThrow('changed field');
  expect(s.store.all('SELECT * FROM calendar_events')).toEqual(before);
});
it('combines appointments and recurring/overdue reminders chronologically without dispatch or model calls',async()=>{
  const s=instance();await invoke(s,definition());
  const reminder=s.runtime.scheduler.create({text:'Recurring task',cron:'0 9 * * *',timezone:'Europe/Rome',kind:'reminder',destination:'terminal',misfire:'once'},'Synthetic');
  s.store.run('UPDATE schedules SET next_due=? WHERE id=?',Date.parse('2099-10-15T07:00Z'),reminder.id);
  const before=s.runtime.scheduler.list(),agenda=s.runtime.calendar.agenda({date:'2099-10-15',period:'week',limit:3},undefined,Date.parse('2099-10-15T08:30Z'));
  expect(agenda.total).toBe(8);expect(agenda.nextOffset).toBe(3);expect(agenda.items.map(item=>item.kind)).toEqual(['reminder','appointment','reminder']);expect(agenda.totalExact).toBe(true);
  expect(s.runtime.scheduler.list()).toEqual(before);expect(s.store.all('SELECT * FROM outbox')).toEqual([]);expect(s.faux.state.callCount).toBe(0);
  s.store.run('UPDATE schedules SET next_due=? WHERE id=?',1,reminder.id);
  expect(s.runtime.calendar.agenda({period:'today'},undefined,Date.parse('2099-10-15T08:30Z')).items[0]).toMatchObject({overdue:true,at:'1970-01-01T00:00:00.001Z'});
});
it('labels bounded recurring projections as incomplete and never hides them as an exact agenda',()=>{
  const s=instance(),reminder=s.runtime.scheduler.create({text:'Every minute',cron:'* * * * *',timezone:'UTC',kind:'reminder',destination:'terminal',misfire:'once'},'Synthetic');
  s.store.run('UPDATE schedules SET next_due=? WHERE id=?',Date.parse('2099-10-15T00:00Z'),reminder.id);
  const agenda=s.runtime.calendar.agenda({date:'2099-10-15',period:'week',timezone:'UTC'});expect(agenda.truncated).toBe(true);expect(agenda.totalExact).toBe(false);expect(agenda.warnings).not.toEqual([]);
});
it('agenda links only the displayed page, not hidden appointment evidence',async()=>{
  const s=instance(),first=await invoke(s,definition()),second=await invoke(s,{...definition(),start:'2099-10-15T14:00+02:00',end:'2099-10-15T15:00+02:00'}),context=owner(s);
  await s.runtime.invokeExtension('agenda',{date:'2099-10-15',limit:1},context);
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',context.runId)).toContainEqual({source_id:`calendar:${first.id}`});
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?',context.runId)).not.toContainEqual({source_id:`calendar:${second.id}`});
});
it('journals calendar writes, binds owner/evidence dependencies and prevents successful receipt replay with changed args',async()=>{
  const s=instance(),created=await turn(s,definition());expect(created.result.isError).not.toBe(true);
  const user=s.store.get<{id:string; text:string}>("SELECT id,text FROM messages WHERE run_id=? AND role='user'",created.run.id)!,event=JSON.parse(created.result.content[0].text);
  expect(s.store.all('SELECT * FROM calendar_sources')).toContainEqual({event_id:event.id,source_id:user.id});
  expect(s.store.all<{tool:string;status:string}>('SELECT tool,status FROM operations WHERE run_id=?',created.run.id)).toContainEqual({tool:'$calendar',status:'completed'});
  const tool=s.runtime.availableTools({...owner(s),conversationId:created.run.conversation_id,runId:created.run.id}).find(tool=>tool.name==='calendar')!;
  const operation=s.store.get<{id:string}>("SELECT id FROM operations WHERE run_id=? AND tool='calendar'",created.run.id)!;
  const callId=operation.id.slice(created.run.id.length+1);expect((await tool.execute(callId,definition())).content).toEqual(created.result.content);
  await expect(tool.execute(callId,{...definition(),title:'Changed replay'})).rejects.toThrow('not replayed');
});
it('survives reconstruction/backup/export and reapplies event deletion tombstones on old restore',async()=>{
  const s=instance(),event=await invoke(s,definition());expect((exportData(s.store) as any).calendarEvents).toHaveLength(1);
  const reminder=s.runtime.scheduler.create({text:'Independent alert',at:'2099-10-15T07:00Z',timezone:'UTC',kind:'reminder',destination:'terminal',misfire:'once'},'Synthetic');s.store.run('INSERT INTO schedule_sources VALUES(?,?)',reminder.id,`calendar:${event.id}`);
  await s.runtime.close();s.runtime=new Runtime(s.store,s.runtime.models);expect(s.runtime.calendar.read(event.id).title).toBe('Dentist');
  const snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pico-planning-backup-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});
  await invoke(s,{action:'delete',id:event.id,expectedRevision:1});expect(s.runtime.scheduler.list()).toHaveLength(1);
  await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);directories.push(s.root);await restore(s.root,external,true);
  const restored=new Store(s.root,s.config);try{expect(restored.all('SELECT * FROM calendar_events')).toEqual([]);expect(restored.all('SELECT * FROM schedules')).toHaveLength(1);expect(restored.all('PRAGMA foreign_key_check')).toEqual([]);}finally{restored.close();}
});
it('forgetting input sources removes derived appointments and linked reminders, including from old backups',async()=>{
  const s=instance(),created=await turn(s,definition()),event=JSON.parse(created.result.content[0].text),user=s.store.get<{id:string;text:string}>("SELECT id,text FROM messages WHERE run_id=? AND role='user'",created.run.id)!;
  const memory=s.runtime.memory.remember({sourceId:user.id,entity:`owner:${s.config.ownerId}`,kind:'fact',key:'synthetic-appointment',value:user.text,quote:user.text,eventAt:Date.now()},false);
  const reminder=s.runtime.scheduler.create({text:'Derived alert',at:'2099-10-15T07:00Z',timezone:'UTC',kind:'reminder',destination:'terminal',misfire:'once'},'Synthetic');s.store.run('INSERT INTO schedule_sources VALUES(?,?)',reminder.id,`calendar:${event.id}`);
  const snapshot=await backup(s.store),external=mkdtempSync(join(tmpdir(),'pico-planning-forget-'));directories.push(external);cpSync(snapshot.path,external,{recursive:true});
  await s.runtime.forget(memory.id);expect(s.store.all('SELECT * FROM calendar_events')).toEqual([]);expect(s.runtime.scheduler.list()).toEqual([]);
  await s.runtime.close();s.store.close();instances.splice(instances.indexOf(s),1);directories.push(s.root);await restore(s.root,external,true);
  const restored=new Store(s.root,s.config);try{expect(restored.all('SELECT * FROM calendar_events')).toEqual([]);expect(restored.all('SELECT * FROM schedules')).toEqual([]);expect(restored.all('PRAGMA foreign_key_check')).toEqual([]);}finally{restored.close();}
});
it('upgrades schema ten without modifying memories, tags, reminders or web tables',async()=>{
  const s=instance(),memory=s.runtime.remember('fixture','preserved','global','fact',undefined,['tests']) as any;
  const reminder=s.runtime.scheduler.create({text:'Preserved',at:'2099-01-01T00:00Z',timezone:'UTC',kind:'reminder',destination:'terminal',misfire:'once'},'Synthetic');
  await s.runtime.close();s.store.db.exec('DROP TABLE calendar_sources;DROP TABLE calendar_events;ALTER TABLE run_sources DROP COLUMN inherited;PRAGMA user_version=10');s.store.close();s.store=new Store(s.root,s.config);s.runtime=new Runtime(s.store,s.runtime.models);
  expect(s.store.get<any>('PRAGMA user_version').user_version).toBe(15);expect(s.runtime.memory.read(memory.id).memory.tags).toEqual(['tests']);expect(s.runtime.scheduler.list()).toHaveLength(1);expect((s.runtime.scheduler.list()[0] as any).id).toBe(reminder.id);expect(s.store.all('SELECT * FROM web_sources')).toEqual([]);
});
it('owner RPC is model-independent and disabling planning retains data but removes dispatch',async()=>{
  const s=instance(),event=await rpc(s.runtime,{op:'calendar',args:definition()}) as any;
  expect(await rpc(s.runtime,{op:'agenda',args:{date:'2099-10-15'}})).toMatchObject({total:1});expect(s.faux.state.callCount).toBe(0);
  await s.runtime.extensions.disable('planning');expect(s.runtime.extensions.tools().map(tool=>tool.name)).not.toContain('calendar');expect(s.runtime.calendar.read(event.id).title).toBe('Dentist');
  await expect(rpc(s.runtime,{op:'agenda',args:{}})).rejects.toThrow('Unknown');
  await s.runtime.extensions.enable('planning');expect(await rpc(s.runtime,{op:'calendar',args:{action:'read',id:event.id}})).toMatchObject({id:event.id});
});
