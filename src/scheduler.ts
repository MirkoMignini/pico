import { CronExpressionParser } from 'cron-parser';
import { Type } from 'typebox';
import { Store, id, json } from './store.js';
import { instant } from './time.js';
import { DestinationSchema, validate, type ScheduleDefinition, type NotificationDelivery } from './contracts.js';

export const ScheduleSchema = Type.Object({ text: Type.String({ minLength: 1, maxLength: 8000 }), timezone: Type.String(),
  at: Type.Optional(Type.String()), cron: Type.Optional(Type.String()), kind: Type.Union([Type.Literal('reminder'), Type.Literal('agent')]),
  destination: DestinationSchema, misfire: Type.Union([Type.Literal('once'), Type.Literal('skip')]) }, { additionalProperties: false });
export type ScheduleAction = 'pause' | 'resume' | 'cancel' | 'update';
export const ScheduleManageSchema = Type.Object({ id: Type.String(), action: Type.Union([Type.Literal('pause'), Type.Literal('resume'), Type.Literal('cancel'), Type.Literal('update')]), definition: Type.Optional(ScheduleSchema) }, { additionalProperties: false });
export function nextDue(definition: ScheduleDefinition, after: number): number {
  new Intl.DateTimeFormat('en', { timeZone: definition.timezone });
  if (!!definition.at === !!definition.cron) throw new Error('Choose exactly one instant with UTC offset or one five-field cron');
  if (definition.at) {
    if (!/(Z|[+-]\d\d:\d\d)$/.test(definition.at)) throw new Error('One-time reminder needs an explicit UTC offset; resolve ambiguous local time first');
    const due = instant(definition.at);
    if (!Number.isFinite(due)) throw new Error('Invalid reminder instant');
    return due;
  }
  if (definition.cron!.trim().split(/\s+/).length !== 5) throw new Error('Five-field calendar cron required; sub-minute schedules disabled');
  return CronExpressionParser.parse(definition.cron!, { tz: definition.timezone, currentDate: new Date(after) }).next().getTime();
}
export class UncertainDelivery extends Error {}
export class RetryableDelivery extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); }
}
export class RejectedDelivery extends Error {}
export class Scheduler {
  private ticking = false;
  constructor(readonly store: Store, readonly deliveries: Map<string, NotificationDelivery>,
    readonly enqueueAgent: (definition: ScheduleDefinition, occurrenceId: string) => Promise<string>) {}
  get defaultDestination(): string { return [...this.deliveries.keys()].find(destination => destination !== 'terminal' && !destination.includes(':')) ?? 'terminal'; }
  create(input: unknown, original: string): { id: string; nextDue: string; definition: ScheduleDefinition } {
    const definition = validate<ScheduleDefinition>(ScheduleSchema, input);
    if (!this.deliveries.has(definition.destination)) throw new Error('Notification destination is not owner-configured');
    const due = nextDue(definition, Date.now());
    if (definition.at && due <= Date.now()) throw new Error('Reminder must be in the future');
    if (this.store.get<{ n: number }>("SELECT count(*) AS n FROM schedules WHERE status='active'")!.n >= 100) throw new Error('Maximum 100 active schedules');
    const scheduleId = id();
    this.store.run('INSERT INTO schedules VALUES(?,?,?,?,?,?)', scheduleId, json(definition), original, due, 'active', Date.now());
    return { id: scheduleId, nextDue: new Date(due).toISOString(), definition };
  }
  list(): unknown[] { return this.store.all('SELECT * FROM schedules ORDER BY next_due LIMIT 200'); }
  snapshot() {
    const schedules = this.store.all<{ id: string; status: string; due_at: number; recurring: number; occurrence_status: string | null; occurrence_due_at: number | null; delivery_status: string | null }>(`SELECT s.id,s.status,s.next_due AS due_at,json_extract(s.definition,'$.cron') IS NOT NULL AS recurring,
      o.status AS occurrence_status,o.due_at AS occurrence_due_at,
      (SELECT status FROM outbox WHERE occurrence_id=o.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS delivery_status
      FROM (SELECT rowid AS position,* FROM schedules ORDER BY created_at DESC,rowid DESC LIMIT 21) s
      LEFT JOIN occurrences o ON o.id=(SELECT id FROM occurrences WHERE schedule_id=s.id ORDER BY due_at DESC LIMIT 1)
      ORDER BY s.created_at DESC,s.position DESC`);
    return {
      asOf: new Date().toISOString(),
      scheduleCounts: Object.fromEntries(this.store.all<{ status: string; count: number }>('SELECT status,count(*) AS count FROM schedules GROUP BY status').map(row => [row.status, row.count])),
      deliveryCounts: Object.fromEntries(this.store.all<{ status: string; count: number }>('SELECT status,count(*) AS count FROM outbox WHERE occurrence_id IS NOT NULL GROUP BY status').map(row => [row.status, row.count])),
      schedules: schedules.slice(0, 20), truncated: schedules.length > 20
    };
  }
  manage(scheduleId: string, action: ScheduleAction, update?: unknown): { id: string; definition: ScheduleDefinition; nextDue: string; status: string } {
    const row = this.store.get<{ definition: string; status: string }>('SELECT * FROM schedules WHERE id=?', scheduleId);
    if (!row) throw new Error('Schedule not found');
    if (action === 'update' && update === undefined) throw new Error('Updating a schedule requires a complete definition');
    const definition = update !== undefined ? validate<ScheduleDefinition>(ScheduleSchema, update) : JSON.parse(row.definition) as ScheduleDefinition;
    if ((action === 'resume' || update !== undefined) && !this.deliveries.has(definition.destination)) throw new Error('Notification destination is not owner-configured');
    const due = nextDue(definition, Date.now());
    if ((action === 'resume' || update !== undefined) && definition.at && due <= Date.now()) throw new Error('Reminder must be in the future');
    const status = action === 'update' ? row.status : action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'cancelled';
    if (status === 'active' && row.status !== 'active' && this.store.get<{ n: number }>("SELECT count(*) AS n FROM schedules WHERE status='active'")!.n >= 100) throw new Error('Maximum 100 active schedules');
    this.store.transaction(() => {
      this.store.run('UPDATE schedules SET definition=?,status=?,next_due=? WHERE id=?', json(definition), status, due, scheduleId);
      if (update !== undefined || action === 'cancel') {
        this.store.run("UPDATE outbox SET status='cancelled' WHERE status IN('pending','paused') AND occurrence_id IN(SELECT id FROM occurrences WHERE schedule_id=?)", scheduleId);
        this.store.run("UPDATE occurrences SET status='cancelled',lease_until=NULL WHERE schedule_id=? AND status IN('pending','paused','leased','running')", scheduleId);
      } else if (action === 'resume') {
        this.store.run("UPDATE outbox SET status='pending' WHERE status='paused' AND occurrence_id IN(SELECT id FROM occurrences WHERE schedule_id=?)", scheduleId);
        this.store.run("UPDATE occurrences SET status='pending' WHERE schedule_id=? AND status='paused'", scheduleId);
      } else if (action === 'pause') {
        this.store.run("UPDATE outbox SET status='paused' WHERE status='pending' AND occurrence_id IN(SELECT id FROM occurrences WHERE schedule_id=?)", scheduleId);
        this.store.run("UPDATE occurrences SET status='paused' WHERE schedule_id=? AND status IN('pending','leased')", scheduleId);
      }
    });
    return { id: scheduleId, definition, nextDue: new Date(due).toISOString(), status };
  }
  outbox(text: string, destination: string, stableId = id(), occurrenceId?: string, due = Date.now()): string {
    if (!this.deliveries.has(destination)) throw new Error('Notification destination is not owner-configured');
    this.store.run("INSERT OR IGNORE INTO outbox(id,occurrence_id,destination,text,status,next_at,created_at) VALUES(?,?,?,?, 'pending',?,?)", stableId, occurrenceId ?? null, destination, text, due, Date.now());
    return stableId;
  }
  recover(): void {
    this.store.run("UPDATE outbox SET status='uncertain',error='Interrupted after dispatch intent; remote acceptance unknown' WHERE status='sending'");
    this.store.run("UPDATE occurrences SET status='pending',lease_until=NULL WHERE status='leased' AND run_id IS NULL");
  }
  history(scheduleId?: string): unknown[] { return this.store.all('SELECT o.*,b.status AS delivery_status,b.error AS delivery_error FROM occurrences o LEFT JOIN outbox b ON b.occurrence_id=o.id WHERE (? IS NULL OR schedule_id=?) ORDER BY due_at DESC LIMIT 100', scheduleId ?? null, scheduleId ?? null); }
  async tick(now = Date.now(),signal?:AbortSignal): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const destinations = json([...this.deliveries.keys()]);
      for (const row of this.store.all<{ id: string; definition: string; next_due: number }>("SELECT * FROM schedules WHERE status='active' AND next_due<=? AND json_extract(definition,'$.destination') IN(SELECT value FROM json_each(?)) ORDER BY next_due LIMIT 20", now, destinations)) {
        const definition = JSON.parse(row.definition) as ScheduleDefinition;
        if (!this.deliveries.has(definition.destination)) continue;
        const occurrence = `${row.id}:${row.next_due}`;
        const skip = definition.misfire === 'skip' && now - row.next_due > 300_000;
        this.store.transaction(() => {
          this.store.run('INSERT OR IGNORE INTO occurrences(id,schedule_id,due_at,status) VALUES(?,?,?,?)', occurrence, row.id, row.next_due, skip ? 'skipped' : 'pending');
          this.store.run('UPDATE schedules SET status=?,next_due=? WHERE id=?', definition.cron ? 'active' : 'finished', definition.cron ? nextDue(definition, now) : row.next_due, row.id);
          if (!skip && definition.kind === 'reminder') { this.outbox(definition.text, definition.destination, `reminder:${occurrence}`, occurrence, now); this.store.run("UPDATE occurrences SET status='completed' WHERE id=?", occurrence); }
        });
      }
      for (const occurrence of this.store.all<{ id: string; definition: string }>("SELECT o.id,s.definition FROM occurrences o JOIN schedules s ON s.id=o.schedule_id WHERE o.status='pending' AND s.status IN('active','finished') AND json_extract(s.definition,'$.destination') IN(SELECT value FROM json_each(?)) LIMIT 4", destinations)) {
        const definition = JSON.parse(occurrence.definition) as ScheduleDefinition;
        if (definition.kind !== 'agent' || !this.deliveries.has(definition.destination) || !this.store.get("SELECT id FROM occurrences WHERE id=? AND status='pending'", occurrence.id)) continue;
        try {
          const runId = await this.enqueueAgent(definition, occurrence.id);
          this.store.run("UPDATE occurrences SET status=CASE WHEN status IN('pending','paused') THEN 'running' ELSE status END,run_id=?,lease_until=CASE WHEN status IN('pending','paused') THEN ? ELSE NULL END WHERE id=?", runId, now + this.store.config.limits.runTimeoutMs * 2, occurrence.id);
        } catch { this.store.run("UPDATE occurrences SET status='failed',error='Task admission failed' WHERE id=? AND status='pending'", occurrence.id); }
      }
      for (const occurrence of this.store.all<{ id: string; status: string; partial: string; definition: string;schedule_status:string }>("SELECT o.id,r.status,r.partial,s.definition,s.status AS schedule_status FROM occurrences o JOIN runs r ON r.id=o.run_id JOIN schedules s ON s.id=o.schedule_id WHERE o.status='running' AND r.status NOT IN ('queued','running')")) {
        const definition = JSON.parse(occurrence.definition) as ScheduleDefinition;
        if (occurrence.status === 'completed' && !this.deliveries.has(definition.destination)) continue;
        this.store.transaction(() => {
          if (occurrence.status === 'completed') {const item=this.outbox(occurrence.partial,definition.destination,`task:${occurrence.id}`,occurrence.id,now);if(occurrence.schedule_status==='paused')this.store.run("UPDATE outbox SET status='paused' WHERE id=? AND status='pending'",item);}
          this.store.run('UPDATE occurrences SET status=?,lease_until=NULL WHERE id=?', occurrence.status, occurrence.id);
        });
      }
      const sent = this.store.get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE id NOT GLOB 'reply:*' AND status IN ('sent','sending','uncertain') AND created_at>=?", now - 86_400_000)!.n;
      let remaining = Math.max(0,this.store.config.limits.notificationsPerDay-sent);
      for (const item of this.store.all<{ id: string; text: string; destination: string; attempts: number }>("SELECT * FROM outbox WHERE status='pending' AND next_at<=? AND attempts<5 AND destination IN(SELECT value FROM json_each(?)) AND (id GLOB 'reply:*' OR ?>0) ORDER BY id GLOB 'reply:*' DESC,next_at LIMIT 4", now,destinations,remaining)) {
        if(signal?.aborted)break;
        const reply=item.id.startsWith('reply:');if(!reply&&!remaining)continue;
        const delivery = this.deliveries.get(item.destination);
        if (!delivery) continue;
        if (!this.store.run("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'", item.id)) continue;
        if(!reply)remaining--;
        try {
          const result = await delivery.send(item.text, item.id,signal);
          this.store.run("UPDATE outbox SET status='sent',remote_id=?,error=NULL WHERE id=?", result.remoteId, item.id);
        } catch (error) {
          const retry = error instanceof RetryableDelivery;
          this.store.run('UPDATE outbox SET status=?,next_at=?,error=? WHERE id=?', retry ? 'pending' : error instanceof RejectedDelivery?'failed':'uncertain', now + Math.max(1000 * 2 ** (item.attempts + 1), retry ? error.retryAfterMs : 0), retry ? 'Provider declined; bounded retry scheduled' : error instanceof RejectedDelivery?'Provider rejected delivery; no acceptance. Owner review required.':'Remote acceptance unknown; explicit owner retry required', item.id);
        }
      }
      this.store.run("UPDATE outbox SET status='failed' WHERE status='pending' AND attempts>=5");
    } finally { this.ticking = false; }
  }
  retry(outboxId: string): void {
    if (!this.store.run("UPDATE outbox SET status='pending',attempts=0,next_at=?,error='Owner explicitly requested at-least-once retry; duplicate possible' WHERE id=? AND status IN ('uncertain','failed')", Date.now(), outboxId)) throw new Error('No uncertain/failed delivery with this ID');
  }
}
