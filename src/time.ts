import { CronDate } from 'cron-parser';
import { Type } from 'typebox';
import { object, validate } from './contracts.js';

export const TimeSchema = object({
  timezone: Type.Optional(Type.String({ maxLength: 100 })),
  at: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  day: Type.Optional(Type.Union([Type.Literal('today'), Type.Literal('tomorrow')])),
  clock: Type.Optional(Type.String({ pattern: '^[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]{1,3})?)?$' })),
  addMinutes: Type.Optional(Type.Integer({ minimum: -525_600, maximum: 525_600 }))
});
const localDate = (date: CronDate): string => `${String(date.getFullYear()).padStart(4,'0')}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export function instant(input: string, timezone?: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(input);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) throw new Error('Invalid ISO date/time');
  const naive = Date.parse(input.slice(0, input.length - (match[6]?.length ?? 0)) + 'Z');
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0,10) !== match[1]) throw new Error('Invalid calendar date');
  if (match[6]) {
    const result = Date.parse(input);
    if (!Number.isFinite(result)) throw new Error('Invalid UTC offset');
    if (new Date(result).getUTCFullYear() < 0 || new Date(result).getUTCFullYear() > 9999) throw new Error('Datetime outside supported years 0000–9999');
    return result;
  }
  if (!timezone) throw new Error('An explicit UTC offset is required');
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  const offsets = new Set([-172_800_000, 0, 172_800_000].map(delta => new CronDate(naive + delta, timezone).getUTCOffset()));
  const candidates = [...offsets].map(offset => naive - offset * 60_000).filter(value => {
    const local = new CronDate(value, timezone), utc = new Date(naive);
    return local.getFullYear() === utc.getUTCFullYear() && local.getMonth() === utc.getUTCMonth() && local.getDate() === utc.getUTCDate() && local.getHours() === utc.getUTCHours() && local.getMinutes() === utc.getUTCMinutes() && local.getSeconds() === utc.getUTCSeconds() && local.getMilliseconds() === utc.getUTCMilliseconds();
  });
  if (candidates.length !== 1) throw new Error(candidates.length ? 'Ambiguous local time; supply an explicit UTC offset' : 'Local time does not exist in this timezone');
  return candidates[0]!;
}
export function timeResult(raw: unknown, defaultTimezone: string, now = Date.now()) {
  const a = validate<{ timezone?: string; at?: string; day?: 'today'|'tomorrow'; clock?: string; addMinutes?: number }>(TimeSchema, raw), timezone = a.timezone ?? defaultTimezone;
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  if (a.at && (a.day || a.clock) || a.clock && !a.day) throw new Error('Use at, or day with optional clock, not both');
  const at = a.day ? `${localDate(new CronDate(dayRange(undefined,a.day,timezone,now).from,timezone))}T${a.clock ?? '00:00'}` : a.at;
  const value = (at ? instant(at, timezone) : now) + (a.addMinutes ?? 0) * 60_000;
  const date = new CronDate(value, timezone), offsetMinutes = date.getUTCOffset();
  if (new Date(value).getUTCFullYear() < 0 || new Date(value).getUTCFullYear() > 9999 || date.getFullYear() < 0 || date.getFullYear() > 9999) throw new Error('Datetime outside supported years 0000–9999');
  if (!Number.isInteger(offsetMinutes)) throw new Error('Historical sub-minute timezone offsets are not supported');
  const pad = (n: number) => String(n).padStart(2,'0'), offset = `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMinutes)/60))}:${pad(Math.abs(offsetMinutes)%60)}`;
  const tomorrow = new CronDate(date,timezone); tomorrow.addDay();
  return { dateLocal:localDate(date),tomorrowLocalDate:localDate(tomorrow),utc: new Date(value).toISOString(), local: new Date(value).toLocaleString('en-GB', { timeZone: timezone }), timezone, offsetMinutes, isoLocal: `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3,'0')}${offset}`, epochMs: value, arithmetic: 'addMinutes means elapsed minutes, not calendar days' };
}
export const AgendaSchema = object({ period: Type.Optional(Type.Union([Type.Literal('today'), Type.Literal('tomorrow'), Type.Literal('week')])), date: Type.Optional(Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' })), timezone: Type.Optional(Type.String({ maxLength: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) });
export function dayRange(date: string | undefined, period: 'today' | 'tomorrow' | 'week', timezone: string, now = Date.now()) {
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  if (date && period === 'tomorrow') throw new Error('Choose a date or tomorrow, not both');
  if (date) instant(`${date}T12:00:00Z`);
  const start = new CronDate(date ? `${date}T12:00:00` : now, timezone);
  if (date && `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}` !== date) throw new Error('Calendar date does not exist in this timezone');
  start.setStartOfDay(); if (period === 'tomorrow') start.addDay();
  const end = new CronDate(start, timezone); for (let n = 0; n < (period === 'week' ? 7 : 1); n++) end.addDay();
  return { from: start.getTime(), to: end.getTime(), timezone };
}
