import type { ExtensionAPI } from '../extensions.js';
import { CalendarToolSchema } from '../calendar.js';
import { AgendaSchema } from '../time.js';
import { jsonTool } from './tools.js';

export default function planning(pico: ExtensionAPI): void {
  jsonTool(pico,'calendar','Local appointments; writes require trusted retained owner foreground work, no mandatory approval. create: title/start/end, optional timezone/location/notes. Ask about missing duration; never invent it. Times need explicit UTC offsets; use time for local dates/DST, never UTC day arithmetic. update/delete need actual id and latest expectedRevision; reuse fresh canonical previews. Returns saved state/conflict IDs. Conflicts warn, never authorize overwriting another event. Appointments create no alerts: use separate reminders. Local writes do not sync externally; use integration tools for remote changes. Use agenda for calendar days; list needs from/to and supports title query/pagination.',CalendarToolSchema,(args,context)=>context.services.calendar(args));
  jsonTool(pico,'agenda','Read local appointments, enabled extension calendars and active reminder/task occurrences for today/tomorrow/next seven local days; optional date/timezone/offset/limit. Includes overdue active reminders today and projects recurrence without dispatching. Follow nextOffset and disclose truncation/incomplete external results; no inferred commitments or automatic calendar copying.',AgendaSchema,(args,context)=>context.services.calendar({action:'agenda',...args}));
  pico.registerRpc({name:'calendar',parameters:CalendarToolSchema,execute:(args,context)=>context.services.calendar(args)});
  pico.registerRpc({name:'agenda',parameters:AgendaSchema,execute:(args,context)=>context.services.calendar({action:'agenda',...args})});
}
