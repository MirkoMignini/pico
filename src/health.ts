import { Type, type Static } from 'typebox';
import { object } from './contracts.js';
import { ReadinessSchema, runtimeReadiness } from './readiness.js';
import { VERSION } from './version.js';
import type { Runtime } from './runtime.js';

export const HealthSchema = object({
  version: Type.String({ maxLength: 80 }), database: Type.Union([Type.Literal('ok'), Type.Literal('failed')]),
  schemaVersion: Type.Integer({ minimum: 0 }), idle: Type.Boolean(), ephemeralSessions: Type.Integer({ minimum: 0 }),
  failedProcessing: Type.Integer({ minimum: 0 }), uncertainDeliveries: Type.Integer({ minimum: 0 }),
  extensionErrors: Type.Integer({ minimum: 0 }), readiness: ReadinessSchema
});
export type Health = Static<typeof HealthSchema>;
export async function health(runtime: Runtime): Promise<Health> {
  const count = (sql: string) => runtime.store.get<{ n: number }>(sql)?.n ?? 0;
  let database: Health['database'] = 'failed';
  try { if (runtime.store.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check === 'ok') database = 'ok'; } catch { /* Return no database text or corrupt row content. */ }
  return { version: VERSION, database, schemaVersion: runtime.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version,
    idle: runtime.canApplySettings, ephemeralSessions: runtime.sessions().filter(session => session.ephemeral).length,
    failedProcessing: count("SELECT count(*) n FROM document_jobs WHERE status IN ('failed','uncertain')") + count("SELECT count(*) n FROM reviews WHERE status='failed'"),
    uncertainDeliveries: count("SELECT count(*) n FROM outbox WHERE status='uncertain'"), extensionErrors: runtime.extensions.errors.size,
    readiness: await runtimeReadiness(runtime) };
}
