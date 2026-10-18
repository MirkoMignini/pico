import { Type, type Static } from 'typebox';
import { object, type Config } from './contracts.js';
import type { Credentials } from './credentials.js';
import { loadConfig } from './config.js';
import type { ModelAccess } from './models.js';
import { assistantText } from './models.js';
import { hash, json } from './store.js';
import type { Runtime } from './runtime.js';

const evidence = Type.Union([Type.Literal('unverified'), Type.Literal('verified'), Type.Literal('not-required')]);
export const ReadinessSchema = object({
  items: Type.Array(object({
    id: Type.Union([Type.Literal('model'), Type.Literal('background-model'), Type.Literal('embeddings'), Type.Literal('telegram'), Type.Literal('transcription'), Type.Literal('speech'), Type.Literal('images'), Type.Literal('search')]),
    enabled: Type.Boolean(), configured: Type.Boolean(), credential: Type.Union([Type.Literal('stored'), Type.Literal('missing'), Type.Literal('not-required')]),
    authenticated: evidence, reachable: evidence,
    tested: Type.Union([Type.Literal('not-run'), Type.Literal('passed'), Type.Literal('failed'), Type.Literal('uncertain')]),
    checkedAt: Type.Optional(Type.Number({ minimum: 0 })), action: Type.String({ maxLength: 300 })
  }), { maxItems: 8 }),
  settingsPending: Type.Boolean(), note: Type.String({ maxLength: 600 })
});
export type Readiness = Static<typeof ReadinessSchema>;
type Probe = { binding: string; tested: 'passed' | 'failed' | 'uncertain'; checkedAt: number; responded: boolean };
const probes = new WeakMap<Runtime, Probe>();
const note = 'Stored credentials are not verified authentication. No external requests, OAuth refresh, model downloads or inference are performed by readiness. Tests apply only to the exact selected model/account during this daemon lifetime; optional services and end-to-end delivery need their own explicit checks.';

export async function configurationReadiness(config: Config, credentials: Credentials, models: ModelAccess): Promise<Readiness> {
  const item = (id: Readiness['items'][number]['id'], enabled: boolean, configured: boolean, credential: Readiness['items'][number]['credential'], action: string): Readiness['items'][number] => ({
    id, enabled, configured, credential, authenticated: credential === 'not-required' ? 'not-required' : 'unverified', reachable: 'unverified', tested: 'not-run', action
  });
  const secret = async (name: string) => await credentials.secret(name) ? 'stored' as const : 'missing' as const;
  return { items: [
    item('model', true, !!models.models.getModel(config.model.provider, config.model.id), await credentials.read(config.model.provider) ? 'stored' : 'missing', '/login or /auth key PROVIDER; choose /model and /model default; explicitly test with /setup'),
    item('embeddings', !!config.embeddings, !!config.embeddings, !config.embeddings || config.embeddings.provider === 'local' ? 'not-required' : await secret('openai.embeddingKey'), '/settings embeddings; null selects lexical-only memory; local weights download only when used'),
    item('telegram', !!config.telegram, !!config.telegram, config.telegram ? await secret('telegram.token') : 'not-required', '/channels telegram setup; /telegram check explicitly contacts Bot API; verify /start and an actual reply separately'),
    item('transcription', !!config.transcription, !!config.transcription, config.transcription ? await secret('openai.mediaKey') : 'not-required', '/settings transcription; /auth secret openai.mediaKey; test with synthetic audio only when authorized'),
    item('speech', !!config.speech, !!config.speech, config.speech ? await secret('openai.speechKey') : 'not-required', '/settings speech; /auth secret openai.speechKey; generation and Telegram delivery are separate checks'),
    item('images', !!config.imageGeneration, !!config.imageGeneration, config.imageGeneration ? await secret('openai.imageKey') : 'not-required', '/settings imageGeneration; /auth secret openai.imageKey; test generation separately (may charge)'),
    item('search', true, true, config.search?.provider === 'brave' ? await secret('brave.searchKey') : 'not-required', '/setup → Web search; a real query discloses its text externally; public search availability is not guaranteed')
  ], settingsPending: false, note };
}
async function binding(runtime: Runtime, selection: Config['model']): Promise<string> {
  return hash(json({ selection, credential: await runtime.credentials.read(selection.provider) }));
}
export async function runtimeReadiness(runtime: Runtime, conversationId?: string): Promise<Readiness> {
  const selection = conversationId ? JSON.parse(runtime.conversation(conversationId).model) as Config['model'] : runtime.store.config.model;
  const result = await configurationReadiness({ ...runtime.store.config, model: selection }, runtime.credentials, runtime.models);
  const probe = probes.get(runtime);
  const applyProbe = async (item: Readiness['items'][number], selection: Config['model']) => {
    if (!probe || probe.binding !== await binding(runtime, selection)) return;
    item.tested = probe.tested; item.checkedAt = probe.checkedAt;
    if (probe.responded) item.authenticated = item.reachable = 'verified';
  };
  await applyProbe(result.items[0]!, selection);
  try { result.settingsPending = json(loadConfig(runtime.store.root).config) !== json(runtime.store.config); } catch { result.settingsPending = true; }
  if (selection.provider !== runtime.store.config.model.provider || selection.id !== runtime.store.config.model.id) {
    const background = (await configurationReadiness(runtime.store.config, runtime.credentials, runtime.models)).items[0]!;
    await applyProbe(background, runtime.store.config.model);
    result.items.push({ ...background, id: 'background-model', action: '/model default PROVIDER/ID selects background/extraction and new-chat defaults; CLI auth test explicitly tests that default' });
  }
  const disabled = JSON.parse(runtime.store.meta('extensions.disabled') ?? '[]') as string[];
  for (const item of result.items) if (disabled.includes(item.id === 'search' ? 'web' : item.id === 'images' ? 'images' : item.id)) item.enabled = false;
  return result;
}
export async function testModel(runtime: Runtime, conversationId?: string) {
  if (!runtime.canApplySettings) throw new Error('Wait for work, delivery and sign-in to finish before testing the model');
  if (conversationId && runtime.isEphemeral(conversationId)) throw new Error('Use a retained session for an explicit model setup test');
  const selection = conversationId ? JSON.parse(runtime.conversation(conversationId).model) as Config['model'] : runtime.store.config.model;
  const identity = await binding(runtime, selection);
  try {
    const response = await runtime.models.complete({ messages: [{ role: 'user', content: 'Reply with exactly: Pico is connected.', timestamp: Date.now() }] }, AbortSignal.timeout(30_000), selection);
    const tested = assistantText(response).trim() === 'Pico is connected.' ? 'passed' : 'failed';
    probes.set(runtime, { binding: identity, tested, checkedAt: Date.now(), responded: true });
    return { completed: true, tested, content: response.content, usage: response.usage };
  } catch {
    probes.set(runtime, { binding: identity, tested: 'uncertain', checkedAt: Date.now(), responded: false });
    throw new Error('Model test did not complete. Provider acceptance or charges may be uncertain; no automatic retry or provider fallback. Inspect readiness and the selected account.');
  }
}

export function formatReadiness(report: Readiness): string {
  return ['**Setup readiness** — local evidence, not a live certification',
    ...report.items.map(item => `- **${item.id}**: ${item.enabled ? 'enabled' : 'disabled'}; configured ${item.configured ? 'yes' : 'no'}; credential ${item.credential}; authenticated ${item.authenticated}; reachable ${item.reachable}; tested ${item.tested}${item.checkedAt ? ` at ${new Date(item.checkedAt).toISOString()}` : ''}. ${item.action}`),
    report.settingsPending ? '**Saved settings are pending.** /reload applies them when idle; this can discard ephemeral sessions.' : '',
    'Google/MCP: use /integrations status google and /mcp status; connection, grants and real effects require separate checks.', report.note].filter(Boolean).join('\n\n');
}
