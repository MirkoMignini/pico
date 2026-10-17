import { CronExpressionParser } from 'cron-parser';
import { Type } from 'typebox';
import { object, validate, type Envelope, type ScheduleDefinition } from './contracts.js';
import { Store, id, hash } from './store.js';
import { AgendaSchema, dayRange, instant, timeResult } from './time.js';
import type { AgendaContribution } from './extensions.js';

const fields = { title: Type.String({ minLength: 1, maxLength: 300 }), start: Type.String({ maxLength: 40 }), end: Type.String({ maxLength: 40 }), timezone: Type.Optional(Type.String({ maxLength: 100 })), location: Type.Optional(Type.String({ maxLength: 1000 })), notes: Type.Optional(Type.String({ maxLength: 4000 })) };
const identity = { id: Type.String({ pattern: '^[a-f0-9-]{36}$' }), expectedRevision: Type.Integer({ minimum: 1 }) };
export const CalendarSchema = Type.Union([
  object({ action: Type.Literal('create'), ...fields }),
  object({ action: Type.Literal('update'), ...identity, ...Object.fromEntries(Object.entries(fields).map(([key,value]) => [key,Type.Optional(value)])) }),
  object({ action: Type.Literal('delete'), ...identity }),
  object({ action: Type.Literal('read'), id: identity.id }),
  object({ action: Type.Literal('list'), from: Type.String({ maxLength: 40 }), to: Type.String({ maxLength: 40 }), query: Type.Optional(Type.String({ maxLength: 200 })), offset: AgendaSchema.properties.offset!, limit: AgendaSchema.properties.limit! }),
  object({ action: Type.Literal('agenda'), ...AgendaSchema.properties })
]);
const toolProperties = Object.assign({}, ...CalendarSchema.anyOf.map(branch => branch.properties));
export const CalendarToolSchema = object({
  ...Type.Partial(object(toolProperties)).properties,
  action: Type.Union(CalendarSchema.anyOf.map(branch => branch.properties.action!))
});
interface EventRow { id: string; title: string; start_at: number; end_at: number; timezone: string; location: string; notes: string; revision: number; created_at: number; updated_at: number }
export class Calendar {
  constructor(readonly store: Store) {}
  private row(eventId: string): EventRow {
    const row = this.store.get<EventRow>('SELECT * FROM calendar_events WHERE id=?',eventId);
    if (!row) throw new Error('Calendar event not found in this instance'); return row;
  }
  private linkRead(eventId: string, context?: Envelope): void {
    if (!context || context.mode === 'ephemeral') return;
    this.store.linkSource(context.runId,`calendar:${eventId}`);
    this.store.run('INSERT INTO run_sources(run_id,source_id,inherited) SELECT ?,source_id,1 FROM calendar_sources WHERE event_id=? ON CONFLICT(run_id,source_id) DO NOTHING',context.runId,eventId);
  }
  read(eventId: string, context?: Envelope) {
    const row = this.row(eventId); this.linkRead(eventId,context);
    return { id:row.id,title:row.title,start:new Date(row.start_at).toISOString(),end:new Date(row.end_at).toISOString(),timezone:row.timezone,location:row.location,notes:row.notes,revision:row.revision,localStart:timeResult({at:new Date(row.start_at).toISOString(),timezone:row.timezone},row.timezone).isoLocal,localEnd:timeResult({at:new Date(row.end_at).toISOString(),timezone:row.timezone},row.timezone).isoLocal };
  }
  operate(raw: unknown, context: Envelope, readOnly = false): unknown {
    if (context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId) throw new Error('Calendar ownership mismatch');
    const a = validate<Record<string,any>>(CalendarSchema,raw);
    if (a.action === 'agenda') { const {action,...args}=a; return this.agenda(args,context); }
    if (a.action === 'read') return this.read(a.id,context);
    if (a.action === 'list') {
      const from = instant(a.from), to = instant(a.to); this.range(from,to);
      const offset = a.offset ?? 0, limit = a.limit ?? 20, query = a.query?.toLowerCase() ?? '';
      const where = 'end_at>? AND start_at<? AND (?=\'\' OR instr(lower(title),?)>0)';
      const total = this.store.get<{n:number}>(`SELECT count(*) n FROM calendar_events WHERE ${where}`,from,to,query,query)!.n;
      const events = this.store.all<{id:string}>(`SELECT id FROM calendar_events WHERE ${where} ORDER BY start_at,id LIMIT ? OFFSET ?`,from,to,query,query,limit,offset).map(row => this.read(row.id,context));
      return { total,offset,nextOffset:offset+limit<total?offset+limit:null,events };
    }
    if (readOnly || context.mode !== 'foreground' || !context.source.trustedOwner) throw new Error('Calendar writes require trusted retained owner foreground work');
    return this.store.transaction(() => {
      const previous = a.action === 'create' ? undefined : this.row(a.id);
      if (previous && previous.revision !== a.expectedRevision) throw new Error('Calendar revision conflict; reread before changing the event');
      if (a.action === 'delete') {
        // Record deletion is not source forgetting: independent reminders must survive restore.
        this.store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)',hash(`calendar-record:${a.id}`),Date.now());
        this.store.run('DELETE FROM calendar_events WHERE id=?',a.id);
        return { id:a.id,effect:'deleted',warning:'Calendar removal does not cancel separately created reminders; manage them explicitly' };
      }
      if (a.action === 'update' && !Object.keys(fields).some(key => a[key] !== undefined)) throw new Error('Calendar update needs at least one changed field');
      const title = a.title ?? previous!.title, start = a.start === undefined ? previous!.start_at : instant(a.start), end = a.end === undefined ? previous!.end_at : instant(a.end), timezone = a.timezone ?? previous?.timezone ?? this.store.config.timezone;
      new Intl.DateTimeFormat('en',{timeZone:timezone});
      if (!title.trim()) throw new Error('Calendar title cannot be blank');
      if (end <= start || end-start > 366*86_400_000) throw new Error('Calendar event must end after it starts and last at most 366 days');
      if (!previous && this.store.get<{n:number}>('SELECT count(*) n FROM calendar_events')!.n >= 10_000) throw new Error('Calendar event limit reached');
      const eventId = previous?.id ?? id(), revision = (previous?.revision ?? 0)+1, now = Date.now();
      this.store.run('INSERT INTO calendar_events VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,timezone=excluded.timezone,location=excluded.location,notes=excluded.notes,revision=excluded.revision,updated_at=excluded.updated_at',eventId,title,start,end,timezone,a.location ?? previous?.location ?? '',a.notes ?? previous?.notes ?? '',revision,previous?.created_at ?? now,now);
      this.store.run('INSERT OR IGNORE INTO calendar_sources SELECT ?,source_id FROM run_sources WHERE run_id=? AND source_id!=? UNION SELECT ?,id FROM messages WHERE run_id=? AND role=\'user\'',eventId,context.runId,`calendar:${eventId}`,eventId,context.runId);
      const total = this.store.get<{n:number}>('SELECT count(*) n FROM calendar_events WHERE id!=? AND start_at<? AND end_at>?',eventId,end,start)!.n;
      const conflicts = this.store.all<{id:string}>('SELECT id FROM calendar_events WHERE id!=? AND start_at<? AND end_at>? ORDER BY start_at,id LIMIT 20',eventId,end,start).map(row => row.id);
      return { ...this.read(eventId,context),effect:previous?'updated':'created',conflicts:{total,ids:conflicts,truncated:total>conflicts.length},notifications:'No automatic alerts; create a separate reminder if requested' };
    });
  }
  private range(from: number,to: number): void { if (to <= from || to-from > 367*86_400_000) throw new Error('Calendar range must be positive and at most 367 elapsed days'); }
  agenda(raw: unknown, context?: Envelope, now = Date.now(), external?: AgendaContribution) {
    if (context && (context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId)) throw new Error('Calendar ownership mismatch');
    const a = validate<{period?:'today'|'tomorrow'|'week';date?:string;timezone?:string;offset?:number;limit?:number}>(AgendaSchema,raw);
    const range = dayRange(a.date,a.period ?? 'today',a.timezone ?? this.store.config.timezone,now), items:Record<string,unknown>[] = []; let truncated = false;
    const events = this.store.all<EventRow>('SELECT * FROM calendar_events WHERE end_at>? AND start_at<? ORDER BY start_at,id LIMIT 1001',range.from,range.to);
    if (events.length > 1000) truncated = true;
    for (const row of events.slice(0,1000)) { items.push({kind:'appointment',id:row.id,title:row.title,at:new Date(row.start_at).toISOString(),end:new Date(row.end_at).toISOString(),location:row.location,revision:row.revision}); }
    const schedules = this.store.all<{id:string;definition:string;next_due:number}>("SELECT * FROM schedules WHERE status='active' ORDER BY next_due,id LIMIT 101");
    if (schedules.length > 100) truncated = true;
    for (const row of schedules.slice(0,100)) {
      const definition = JSON.parse(row.definition) as ScheduleDefinition;
      const add = (due: number) => { items.push({kind:definition.kind,id:row.id,title:definition.text,at:new Date(due).toISOString(),destination:definition.destination,overdue:due<now,recurring:!!definition.cron}); };
      if (row.next_due < range.to && (row.next_due >= range.from || !a.date && (a.period ?? 'today') === 'today')) add(row.next_due);
      if (definition.cron) {
        const iterator = CronExpressionParser.parse(definition.cron,{tz:definition.timezone,currentDate:new Date(Math.max(row.next_due,range.from-1))});
        for (let n=0;n<256;n++) { const due=iterator.next().getTime(); if(due>=range.to)break; add(due); if(n===255)truncated=true; }
      }
    }
    if(external){items.push(...external.items.map(item=>({...item,kind:'external_appointment'})));truncated ||= external.truncated;}
    items.sort((left,right) => String(left.at).localeCompare(String(right.at)) || String(left.id).localeCompare(String(right.id)));
    const offset=a.offset ?? 0,limit=a.limit ?? 20,page=items.slice(offset,offset+limit);
    for (const item of page) {
      if (item.kind === 'appointment') this.linkRead(item.id as string,context);
      else if (item.kind!=='external_appointment' && context && context.mode !== 'ephemeral') this.store.run('INSERT INTO run_sources(run_id,source_id,inherited) SELECT ?,source_id,1 FROM schedule_sources WHERE schedule_id=? ON CONFLICT(run_id,source_id) DO NOTHING',context.runId,item.id as string);
    }
    return { timezone:range.timezone,from:new Date(range.from).toISOString(),to:new Date(range.to).toISOString(),total:items.length,totalExact:!truncated,truncated,offset,nextOffset:offset+limit<items.length?offset+limit:null,items:page.map(item=>({...item,local:timeResult({at:item.at,timezone:range.timezone},range.timezone).isoLocal})),scope:external?'Local Pico appointments/reminders plus enabled extension calendars; no inferred commitments':'Local Pico appointments and active reminder/task occurrences only; no external calendar sync or inferred commitments',warnings:[...(truncated?['Incomplete preview: local/extension projection limits apply']:[]),...(external?.warnings??[])] };
  }
}
export const hashEvent = (eventId: string): string => hash(`calendar:${eventId}`);
