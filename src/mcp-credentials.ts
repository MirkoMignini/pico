import { Type } from 'typebox';
import { object, validate } from './contracts.js';
import type { Credentials } from './credentials.js';
import { McpCredentialsSchema, type McpCredentials, type McpServer } from './mcp-contracts.js';
import { hash, json } from './store.js';

const StoredSchema = object({ binding: Type.String({ pattern: '^[a-f0-9]{64}$' }), data: McpCredentialsSchema });
export function mcpCredentialBinding(server: McpServer): string {
  return hash(json(server.transport === 'stdio'
    ? { id: server.id, transport: server.transport, command: server.command, args: server.args ?? [], cwd: server.cwd, env: server.env ?? {} }
    : { id: server.id, transport: server.transport, url: server.url, headers: server.headers ?? {}, clientId: server.oauth?.clientId, issuer: server.oauth?.issuer, grantType: server.oauth?.grantType, ...(server.browserBridgeId ? { browserBridgeId: server.browserBridgeId } : {}) }));
}
export function encodeMcpCredentials(server: McpServer, value: string): string {
  let data: McpCredentials;
  try { data = validate<McpCredentials>(McpCredentialsSchema, JSON.parse(value)); }
  catch { throw new Error('Invalid MCP credential JSON; expected env, headers and/or oauthClientSecret'); }
  if (server.transport === 'stdio' && (data.headers || data.oauthClientSecret) || server.transport !== 'stdio' && data.env) throw new Error('MCP stdio accepts only env credentials; HTTP/SSE accepts headers and OAuth client secrets');
  return json({ binding: mcpCredentialBinding(server), data });
}
export async function readMcpCredentials(credentials: Credentials, server: McpServer): Promise<McpCredentials> {
  const raw = await credentials.secret(`extensions.mcp.${server.id}`);
  if (!raw) return {};
  let stored: { binding: string; data: McpCredentials };
  try { stored = validate(StoredSchema, JSON.parse(raw)); }
  catch { throw new Error('Invalid MCP vault record; re-enter credentials through the masked setup flow'); }
  if (stored.binding !== mcpCredentialBinding(server)) throw new Error('MCP endpoint/command or account changed; re-enter credentials explicitly before connecting. Existing credentials were not forwarded or deleted.');
  return stored.data;
}
