import { ScheduleSchema } from '../scheduler.js';
import type { ScheduleDefinition } from '../contracts.js';
import type { ExtensionAPI } from '../extensions.js';
import { jsonTool } from './tools.js';

export default function reminders(pico: ExtensionAPI): void {
  jsonTool(pico, 'schedule_create', 'Create/activate a durable reminder/task directly, without confirmation or approval. Use time for precise relative dates with explicit UTC offset and IANA timezone; follow the current channel reminder destination. Delivery is model-independent. Report only saved receipt state.', ScheduleSchema, (args, context) => context.services.createSchedule(args as unknown as ScheduleDefinition));
}
