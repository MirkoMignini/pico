import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

export const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1, maxLength: 32_000 });
// Pi's thinking levels; the model clamps the selected level to what it supports.
export const ThinkingLevelSchema = Type.Union([
  Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
const modelThinking = Type.Record(Type.String({ minLength: 3, maxLength: 200 }), ThinkingLevelSchema);
export const ConfigSchema = Type.Object({
  version: Type.Literal(1), ownerId: text, ownerName: text, instanceId: text,
  timezone: Type.String({ default: 'Europe/Rome' }),
  model: Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }),
  // Pi-compatible thinking defaults: global level plus per-model overrides keyed provider/model.
  thinking: Type.Optional(ThinkingLevelSchema),
  modelThinking: Type.Optional(modelThinking),
  limits: Type.Object({ activeRuns: Type.Integer({ minimum: 1, maximum: 4 }),
    turns: Type.Integer({ minimum: 1, maximum: 30 }), runTimeoutMs: Type.Integer({ minimum: 1000, maximum: 600_000 }),
    contextChars: Type.Integer({ minimum: 4000, maximum: 400_000 }), attachmentBytes: Type.Integer({ minimum: 1024, maximum: 20_000_000 }),
    notificationsPerDay: Type.Integer({ minimum: 0, maximum: 200 }), backgroundIntervalMs: Type.Integer({ minimum: 1000 })
  }, { additionalProperties: false }),
  oauth:Type.Optional(Type.Object({listenHost:Type.Union([Type.Literal('127.0.0.1'),Type.Literal('0.0.0.0')]),chatgptPort:Type.Integer({minimum:1024,maximum:65535}),gmailPort:Type.Integer({minimum:1024,maximum:65535})},{additionalProperties:false})),
  telegram: Type.Optional(Type.Object({ allowedSenders: Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { minItems: 1 }),
    destination: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })),
  gmail: Type.Optional(Type.Object({ clientId: text, intervalMs: Type.Integer({ minimum: 60_000 }), baselineMax: Type.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false })),
  embeddings: Type.Optional(Type.Object({ provider: Type.Optional(Type.Union([Type.Literal('openai'), Type.Literal('local')])), model: text, dimensions: Type.Integer({ minimum: 1, maximum: 4096 }), maxScan: Type.Optional(Type.Integer({ minimum: 100, maximum: 100_000 })) }, { additionalProperties: false })),
  transcription: Type.Optional(Type.Object({ provider: Type.Literal('openai'), model: text }, { additionalProperties: false })),
  speech: Type.Optional(Type.Object({ provider: Type.Literal('openai'), model: Type.String({ minLength: 1, maxLength: 100 }), voice: Type.String({ pattern: '^[a-z][a-z0-9-]{0,99}$' }) }, { additionalProperties: false })),
  imageGeneration: Type.Optional(Type.Object({ provider: Type.Literal('openai'), model: Type.String({ minLength: 1, maxLength: 100 }), quality: Type.Optional(Type.Union(['low','medium','high'].map(value => Type.Literal(value)))) }, { additionalProperties: false })),
  search: Type.Optional(Type.Object({ provider: Type.Union([Type.Literal('duckduckgo'), Type.Literal('brave')]) }, { additionalProperties: false })),
  quietHours: Type.Object({ start: Type.Integer({ minimum: 0, maximum: 23 }), end: Type.Integer({ minimum: 0, maximum: 23 }) }, { additionalProperties: false }),
  retention: Type.Object({ backupDays: Type.Integer({ minimum: 0, maximum: 365 }), mediaDays: Type.Integer({ minimum: 1, maximum: 3650 }) }, { additionalProperties: false })
}, { additionalProperties: false });
export type Config = Static<typeof ConfigSchema>;
export interface AuthProvider { id: string; name: string; methods: { type: 'oauth' | 'api_key'; label: string }[] }
export const SECRET_NAMES = ['telegram.token', 'openai.mediaKey', 'openai.embeddingKey', 'gmail.clientSecret', 'brave.searchKey', 'openai.imageKey', 'openai.speechKey'] as const;
const settings = Type.Partial(Type.Pick(ConfigSchema, ['timezone', 'model', 'thinking', 'modelThinking', 'telegram', 'gmail', 'embeddings', 'transcription', 'speech', 'search', 'imageGeneration', 'quietHours', 'retention']));
export const SettingsSchema = object({ ...settings.properties, ...Object.fromEntries(['thinking', 'modelThinking', 'telegram', 'gmail', 'embeddings', 'transcription', 'speech', 'search', 'imageGeneration'].map(key =>
  [key, Type.Optional(Type.Union([settings.properties[key as keyof typeof settings.properties], Type.Null()]))])) });
export const ChannelSchema = Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$', maxLength: 48 });
export type Channel = Static<typeof ChannelSchema>;
export const DestinationSchema = Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}(?::[^\\s\\x00-\\x1f\\x7f]+)?$', maxLength: 200 });
export const ChannelSourceSchema = object({ channel: ChannelSchema, identity: Type.String({ minLength: 1, maxLength: 200 }),
  trustedOwner: Type.Boolean(), eventAt: Type.Optional(Type.Number({ minimum: 0 })) });
export interface Envelope {
  ownerId: string; instanceId: string; conversationId: string; runId: string;
  source: { channel: Channel; identity: string; trustedOwner: boolean;eventAt?:number };
  mode: 'foreground' | 'scheduled' | 'review' | 'ephemeral';
}
export const InputSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 200 }), conversationId: Type.String(), text,
  attachments: Type.Optional(Type.Array(Type.String(), { maxItems: 10 }))
}, { additionalProperties: false });
export type ChannelInput = Static<typeof InputSchema>;
export interface ToolOutput { id: string; tool: string; state: 'tool_call' | 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'; args?: unknown; result?: unknown; error?: boolean; incomplete?: boolean; durationMs?: number }
export interface AssistantOutput { id: string; text: string; thinking: string; intermediate: boolean; complete: boolean; tools?: ToolOutput[]; instructionsId?: string; rejectedDraft?: string }
export interface OutputEvent { type: 'accepted' | 'instructions' | 'assistant' | 'image' | 'delta' | 'tool' | 'settled' | 'notification' | 'status' | 'diagnostic' | 'extension_status'; channel?: Channel; runId?: string; conversationId?: string; data: unknown }
export interface ProviderCapabilities { provider: string; model: string; text: boolean; tools: boolean; images: boolean; streaming: boolean; cancellation: boolean; structured: boolean; contextWindow: number; authentication: 'api_key' | 'subscription' | 'fixture' | 'unconfigured'; transcription: boolean; embeddings: boolean }
export interface MemoryRecord { id: string; entity: string; kind: string; key: string; value: string; scope: string; source_id: string; status: string; basis: string; event_at: number; recorded_at: number; valid_until: number | null; supersedes: string | null; tags?: string[] }
export const MemoryTagsSchema = Type.Array(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,47}$', maxLength: 48 }), { maxItems: 8, uniqueItems: true });
export const MemoryTagSchema = object({ id: Type.String({ minLength: 1, maxLength: 200 }), tags: MemoryTagsSchema });
export const MemoryListSchema = object({ status: Type.Optional(Type.Union(['current','stored','superseded','confirmed'].map(value => Type.Literal(value)))), tags: Type.Optional(MemoryTagsSchema) });
export const MemoryCaptureSchema = object({
  entity: Type.String({ minLength: 1, maxLength: 200 }), kind: Type.Union(['fact','preference','decision','commitment'].map(value => Type.Literal(value))),
  key: Type.String({ minLength: 1, maxLength: 200 }), value: Type.String({ minLength: 1, maxLength: 4000 }), sourceId: text,
  eventAt: Type.Number({ minimum: 0 }), scope: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  basis: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('inferred')])), status: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('stored')])),
  validUntil: Type.Optional(Type.Number({ minimum: 0 })), quote: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  contextSourceIds: Type.Optional(Type.Array(text, { maxItems: 4, uniqueItems: true })), tags: Type.Optional(MemoryTagsSchema)
});
export const MemorySearchSchema = object({ query: Type.String({ minLength: 1, maxLength: 32_000 }), entity: Type.Optional(Type.String({ maxLength: 200 })),
  scope: Type.Optional(Type.String({ maxLength: 80 })), since: Type.Optional(Type.Number({ minimum: 0 })), until: Type.Optional(Type.Number({ minimum: 0 })),
  history: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  tags: Type.Optional(MemoryTagsSchema), kind: Type.Optional(MemoryCaptureSchema.properties.kind!), basis: MemoryCaptureSchema.properties.basis! });
export interface MemorySearch { query: string; entity?: string; scope?: string; since?: number; until?: number; history?: boolean; limit?: number; tags?: string[]; kind?: MemoryCapture['kind']; basis?: MemoryCapture['basis'] }
export interface SearchResult { id: string; kind: string; text: string; score: number; sourceId: string; eventAt: number; entity?: string; sourceActor?: string; eventTime?: string; facts?: (MemoryRecord & { quote?: string })[] }
export interface MemoryCapture { entity: string; kind: 'fact' | 'preference' | 'decision' | 'commitment'; key: string; value: string; sourceId: string; eventAt: number; scope?: string; basis?: 'direct' | 'inferred'; status?: 'current' | 'stored'; validUntil?: number; quote?: string; contextSourceIds?: string[]; tags?: string[] }
export interface EmbeddingProvider { model: string; dimensions: number; version: string; embed(texts: string[], signal?: AbortSignal, purpose?: 'query' | 'passage'): Promise<number[][]> }
export interface ScheduleDefinition { text: string; timezone: string; at?: string; cron?: string; kind: 'reminder' | 'agent'; destination: string; misfire: 'once' | 'skip' }
export interface NotificationDelivery { send(text: string, id: string,signal?:AbortSignal): Promise<{ remoteId: string }> }
export interface PicoChannel {
  readonly id: Channel;
  readonly deliveries?: ReadonlyMap<string, NotificationDelivery>;
  start(): void | Promise<void>;
  onOutput?(event: OutputEvent): void | Promise<void>;
  close(): void | Promise<void>;
}
export function validate<T>(schema: TSchema, value: unknown): T {
  if (!Value.Check(schema, value)) throw new Error(`Invalid input: ${[...Value.Errors(schema, value)].slice(0, 3).map(e => `${e.instancePath}: ${e.message}`).join('; ')}`);
  return value as T;
}
export const RpcSchema = Type.Object({ op: Type.String({ maxLength: 80 }), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false });
export interface RpcRequest { op: string; args?: Record<string, unknown> }
