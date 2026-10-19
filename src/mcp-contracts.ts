import { Type, type Static } from 'typebox';
import { object, validate } from './contracts.js';
import { BridgeIdSchema } from './browser-bridge-contracts.js';

export const McpIdSchema = Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' });
const name = Type.String({ minLength: 1, maxLength: 256 });
const strings = Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 16_000 }), { maxProperties: 100 });
const common = {
  id: McpIdSchema, enabled: Type.Boolean(),
  tools: Type.Optional(Type.Array(name, { maxItems: 2000, uniqueItems: true })),
  readOnlyTools: Type.Optional(Type.Array(name, { maxItems: 2000, uniqueItems: true })),
  autonomousTools: Type.Optional(Type.Array(name, { maxItems: 2000, uniqueItems: true })),
  resources: Type.Optional(Type.Boolean()), prompts: Type.Optional(Type.Boolean()),
  roots: Type.Optional(Type.Array(object({ uri: Type.String({ minLength: 1, maxLength: 4000 }), name: Type.Optional(name) }), { maxItems: 100 })),
  sampling: Type.Optional(Type.Boolean()), elicitation: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 20_000_000 })),
  artifactDirectory: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  browserBridgeId: Type.Optional(BridgeIdSchema),
  protocol: Type.Optional(Type.Union([Type.Literal('legacy'), Type.Literal('auto'), object({ pin: Type.String({ pattern: '^20\\d{2}-\\d{2}-\\d{2}$' }) })]))
};
export const McpServerSchema = Type.Union([
  object({ ...common, transport: Type.Literal('stdio'), command: Type.String({ minLength: 1, maxLength: 4000 }), args: Type.Optional(Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 128 })), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })), env: Type.Optional(strings) }),
  object({ ...common, transport: Type.Union([Type.Literal('http'), Type.Literal('sse')]), url: Type.String({ minLength: 1, maxLength: 4000 }), headers: Type.Optional(strings), allowPrivateNetwork: Type.Optional(Type.Boolean()), oauth: Type.Optional(object({ clientId: Type.Optional(name), issuer: Type.Optional(Type.String({ maxLength: 4000 })), grantType: Type.Optional(Type.Union([Type.Literal('authorization_code'), Type.Literal('client_credentials')])), callbackPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })), scope: Type.Optional(Type.String({ maxLength: 4000 })), clientMetadataUrl: Type.Optional(Type.String({ maxLength: 4000 })) })) })
]);
export const McpSettingsSchema = object({ servers: Type.Array(McpServerSchema, { maxItems: 64 }) });
export type McpServer = Static<typeof McpServerSchema>;
export type McpSettings = Static<typeof McpSettingsSchema>;
export const McpCredentialsSchema = object({ env: Type.Optional(strings), headers: Type.Optional(strings), oauthClientSecret: Type.Optional(Type.String({ maxLength: 16_000 })) });
export type McpCredentials = Static<typeof McpCredentialsSchema>;
export const McpServerRefSchema = object({ server: McpIdSchema });
export const McpImportSchema = object({
  server: McpIdSchema, sourceId: Type.String({ minLength: 1, maxLength: 500 }),
  contentIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  file: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  mime: Type.Optional(Type.String({ minLength: 1, maxLength: 100 }))
});
export type McpImport = Static<typeof McpImportSchema>;
export const McpArtifactReadSchema = object({ server: McpIdSchema, sourceId: McpImportSchema.properties.sourceId, file: Type.String({ minLength: 1, maxLength: 120 }), fromOffset: Type.Optional(Type.Integer({ minimum: 0 })), maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })) });
export type McpArtifactRead = Static<typeof McpArtifactReadSchema>;
export const McpCatalogSchema = object({ server: Type.Optional(McpIdSchema), kind: Type.Optional(Type.Union(['tools', 'resources', 'templates', 'prompts'].map(value => Type.Literal(value)))), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) });
export const McpCallSchema = object({ server: McpIdSchema, name, arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())), task: Type.Optional(object({ ttl: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86_400_000 })) })) });
export const McpResourceSchema = object({ server: McpIdSchema, uri: Type.String({ minLength: 1, maxLength: 4000 }), action: Type.Optional(Type.Union(['read', 'subscribe', 'unsubscribe'].map(value => Type.Literal(value)))) });
export const McpPromptSchema = object({ server: McpIdSchema, name, arguments: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 16_000 }))) });
export const McpCompleteSchema = object({ server: McpIdSchema, ref: Type.Union([object({ type: Type.Literal('ref/prompt'), name }), object({ type: Type.Literal('ref/resource'), uri: Type.String({ minLength: 1, maxLength: 4000 }) })]), argument: object({ name, value: Type.String({ maxLength: 16_000 }) }), context: Type.Optional(object({ arguments: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 16_000 }))) })) });
export const McpTaskSchema = object({ server: McpIdSchema, action: Type.Union(['list', 'get', 'result', 'cancel'].map(value => Type.Literal(value))), taskId: Type.Optional(name), cursor: Type.Optional(Type.String({ maxLength: 4000 })) });
export const McpLogSchema = object({ server: McpIdSchema, level: Type.Union(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].map(value => Type.Literal(value))) });
export const McpRequestReplySchema = object({ id: Type.String({ minLength: 1, maxLength: 200 }), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }), action: Type.Union(['accept', 'decline', 'cancel'].map(value => Type.Literal(value))), content: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });

export function mcpSettings(raw: unknown): McpSettings {
  const settings = validate<McpSettings>(McpSettingsSchema, raw), ids = new Set<string>();
  for (const server of settings.servers) {
    if (ids.has(server.id)) throw new Error('Duplicate MCP server ID');
    ids.add(server.id);
    if (server.browserBridgeId && (server.transport !== 'http' || server.artifactDirectory)) throw new Error('Browser bridge artifacts require HTTP without a local artifact directory');
    for (const tool of server.autonomousTools ?? []) {
      if (!server.tools?.includes(tool)) throw new Error('Autonomous MCP tools must be exact names in the explicit tools allowlist');
      if (server.readOnlyTools?.includes(tool)) throw new Error('Autonomous MCP effects must not also be classified as read-only');
    }
    if (server.artifactDirectory && (!server.artifactDirectory.startsWith('/') || /[\x00-\x1f\x7f]/.test(server.artifactDirectory))) throw new Error('MCP artifact directory must be an explicit absolute path');
    for (const root of server.roots ?? []) {
      const uri = new URL(root.uri);
      if (uri.protocol !== 'file:' || uri.hostname && uri.hostname !== 'localhost' || uri.username || uri.password || uri.search || uri.hash) throw new Error('MCP roots must be explicit local file URIs');
    }
    if (server.transport === 'stdio') {
      if (/[\x00-\x1f\x7f]/.test(server.command) || server.args?.some(arg => /\x00/.test(arg))) throw new Error('Invalid MCP command or arguments');
      for (const key of Object.keys(server.env ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)/i.test(key)) throw new Error('Put MCP environment credentials in the masked credential vault, not settings');
    } else {
      mcpUrl(server.url);
      for (const key of Object.keys(server.headers ?? {})) if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /authorization|cookie|token|key|secret|credential/i.test(key)) throw new Error('Put MCP authentication headers in the masked credential vault, not settings');
      if (server.oauth?.clientMetadataUrl) mcpUrl(server.oauth.clientMetadataUrl);
      if (server.oauth?.issuer) mcpUrl(server.oauth.issuer);
      if (server.oauth?.clientId && !server.oauth.issuer || server.oauth?.grantType === 'client_credentials' && !server.oauth.clientId) throw new Error('Pre-registered MCP OAuth clients require an explicit clientId and issuer');
    }
  }
  return settings;
}
export function mcpUrl(raw: string): URL {
  if (/[\s\x00-\x1f\x7f\\]/.test(raw)) throw new Error('Invalid MCP URL');
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP requires HTTP(S) URLs without inline credentials or fragments');
  if ([...url.searchParams.keys()].some(key => /token|secret|password|api[-_]?key|credential/i.test(key))) throw new Error('Put MCP URL credentials in the masked vault as headers');
  return url;
}
