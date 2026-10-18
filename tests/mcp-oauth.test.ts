import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { McpOAuth } from '../src/mcp-oauth.js';
import { encodeMcpCredentials, readMcpCredentials } from '../src/mcp-credentials.js';
import { rpc } from '../src/daemon.js';
import type { McpServer } from '../src/mcp-contracts.js';
import { setup, source, waitFor } from './helpers.js';
import { fixture } from './fixtures/mcp-server.mjs';

const instances: ReturnType<typeof setup>[] = [], servers: Server[] = [];
const connections: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
  for (const connection of connections.splice(0)) await connection.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const invoke = (s: ReturnType<typeof setup>, name: string, args: Record<string, unknown> = {}): Promise<any> => rpc(s.runtime, { op: `extensions.mcp.${name}`, args });

it('binds private credentials to the exact server/command, rejects invalid secrets and never forwards stale bindings', async () => {
  const s = setup('mcp-binding'); instances.push(s);
  const server: McpServer = { id: 'fixture', enabled: true, transport: 'http', url: 'https://resource.example/mcp' };
  await s.runtime.credentials.setSecret('extensions.mcp.fixture', encodeMcpCredentials(server, '{"headers":{"Authorization":"Bearer synthetic-only"}}'));
  expect(await readMcpCredentials(s.runtime.credentials, server)).toMatchObject({ headers: { Authorization: 'Bearer synthetic-only' } });
  await expect(readMcpCredentials(s.runtime.credentials, { ...server, url: 'https://different.example/mcp' })).rejects.toThrow('not forwarded');
  expect(() => encodeMcpCredentials(server, '{"env":{"TOKEN":"synthetic"}}')).toThrow('HTTP/SSE');
  expect(() => encodeMcpCredentials(server, '{"invalid":"never-echo-this"}')).toThrow('Invalid MCP credential JSON');
  const provider = await McpOAuth.create({ ...server, oauth: { clientId: 'chosen', issuer: 'https://issuer.example' } }, s.runtime.credentials).catch(() => undefined);
  expect(provider).toBeUndefined(); // Changing the selected account cannot silently reuse an old header credential.
});

it('keeps OAuth tokens issuer/resource/config-bound and stages replacement until commit', async () => {
  const s = setup('mcp-oauth-state'); instances.push(s);
  const config: Exclude<McpServer, { transport: 'stdio' }> = { id: 'fixture', enabled: true, transport: 'http', url: 'https://resource.example/mcp', oauth: { issuer: 'https://issuer.example', clientId: 'selected-client' } };
  const context = { issuer: 'https://issuer.example' };
  const provider = await McpOAuth.create(config, s.runtime.credentials, { redirectUrl: 'http://127.0.0.1:12345/mcp/callback', show: () => {} });
  const state = provider.state(); expect(state.length).toBeGreaterThan(32); expect(provider.csrf).toBe(state);
  provider.saveCodeVerifier('synthetic-verifier'); expect(provider.codeVerifier()).toBe('synthetic-verifier');
  await provider.saveTokens({ access_token: 'synthetic-token', token_type: 'Bearer', issuer: context.issuer }, context);
  expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toBeUndefined();
  const cancelled = new AbortController(); cancelled.abort(new Error('Synthetic login cancelled'));
  await expect(provider.commit(cancelled.signal)).rejects.toThrow('cancelled');
  expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toBeUndefined();
  await provider.commit(); expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toContain('synthetic-token');
  await expect(provider.saveTokens({ access_token: 'foreign-token', token_type: 'Bearer', issuer: 'https://foreign.example' }, { issuer: 'https://foreign.example' })).rejects.toThrow('issuer');
  await expect(provider.validateResourceURL(config.url, 'https://foreign.example/mcp')).rejects.toThrow('audience');
  expect((await McpOAuth.create(config, s.runtime.credentials)).ready).toBe(true);
  expect((await McpOAuth.create({ ...config, url: 'https://different.example/mcp' }, s.runtime.credentials)).ready).toBe(false);
});

async function authenticatedFixture(machine = false) {
  const s = setup('mcp-local-oauth'); instances.push(s); await s.runtime.start();
  let base = '', access = '', refresh = '', sequence = 0, challenge = '', redirect = '';
  const counts = { registration: 0, code: 0, refresh: 0, machine: 0, leakedGateway: 0, verifier: false, resource: false, toolCalls: 0, tokenReplies: 0 };
  let pauseToken = async () => {};
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const http = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks), url = new URL(request.url!, base);
      const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value)); };
      if (url.pathname !== '/mcp' && request.headers['x-gateway-key']) counts.leakedGateway++;
      if (url.pathname === '/metadata') { json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read'] }); return; }
      if (url.pathname === '/.well-known/oauth-authorization-server') { json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'], token_endpoint_auth_methods_supported: machine ? ['client_secret_post'] : ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true }); return; }
      if (url.pathname === '/register') { counts.registration++; const data = JSON.parse(body.toString()); redirect = data.redirect_uris[0]; json({ ...data, client_id: 'synthetic-client' }, 201); return; }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body.toString());
        counts.resource = form.get('resource') === `${base}/mcp`;
        if (form.get('grant_type') === 'authorization_code') {
          counts.code++; counts.verifier = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
          if (!counts.verifier || form.get('code') !== 'synthetic-code' || form.get('redirect_uri') !== redirect) { json({ error: 'invalid_grant' }, 400); return; }
        } else if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === refresh) counts.refresh++;
        else if (machine && form.get('grant_type') === 'client_credentials' && form.get('client_secret') === 'synthetic-machine-secret') counts.machine++;
        else { json({ error: 'invalid_grant' }, 400); return; }
        await pauseToken(); counts.tokenReplies++;
        sequence++; access = `synthetic-access-${sequence}`; refresh = `synthetic-refresh-${sequence}`;
        json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'read' }); return;
      }
      if (url.pathname !== '/mcp') { json({ error: 'not_found' }, 404); return; }
      if (!access || request.headers.authorization !== `Bearer ${access}` || request.headers['x-gateway-key'] !== 'synthetic-gateway') { response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/metadata", scope="read"` }).end(); return; }
      if (body.length && JSON.parse(body.toString()).method === 'tools/call') counts.toolCalls++;
      let transport = sessions.get(String(request.headers['mcp-session-id'] ?? ''));
      if (!transport) {
        const server = fixture(); connections.push(server);
        transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true, onsessioninitialized: session => sessions.set(session, transport!) });
        await server.connect(transport);
      }
      const result = await transport.handleRequest(new Request(`${base}${request.url}`, { method: request.method, headers: request.headers as Record<string, string>, ...(body.length ? { body } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); if (result.body) Readable.fromWeb(result.body as any).pipe(response); else response.end();
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  servers.push(http); http.listen(0, '127.0.0.1'); await once(http, 'listening'); base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ id: 'fixture', enabled: true, transport: 'http', url: `${base}/mcp`, allowPrivateNetwork: true, protocol: 'legacy', readOnlyTools: ['read.echo'], oauth: { issuer: base, scope: 'read', ...(machine ? { clientId: 'synthetic-machine-client', grantType: 'client_credentials' } : {}) } }] } } });
  await rpc(s.runtime, { op: 'extensions.secret', args: { id: 'mcp', name: 'fixture', value: JSON.stringify({ headers: { 'x-gateway-key': 'synthetic-gateway' }, ...(machine ? { oauthClientSecret: 'synthetic-machine-secret' } : {}) }) } });
  return { s, base, counts, challenge: (value: string) => { challenge = value; }, expire: () => { access = 'expired-server-token'; }, pauseToken: (wait: () => Promise<void>) => { pauseToken = wait; } };
}

it('round-trips real HTTP OAuth discovery, DCR, PKCE, loopback state/issuer checks, token persistence, refresh and logout', async () => {
  const { s, base, counts, challenge, expire } = await authenticatedFixture();
  await expect(invoke(s, 'connect', { server: 'fixture' })).rejects.toThrow('OAuth'); expect(counts.registration).toBe(0);
  const login = await invoke(s, 'auth', { server: 'fixture' }), url = new URL(login.url);
  challenge(url.searchParams.get('code_challenge')!);
  expect(login.allowInsecureLocal).toBe(true); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ code: 'synthetic-code', state: 'wrong-state', iss: base }).toString();
  expect((await fetch(callback)).status).toBe(400); expect(counts.code).toBe(0);
  callback.searchParams.set('state', url.searchParams.get('state')!);
  expect((await fetch(callback)).status).toBe(200);
  expect(counts).toMatchObject({ registration: 1, code: 1, verifier: true, resource: true, leakedGateway: 0 });
  expect((await invoke(s, 'status')).servers[0]).toMatchObject({ state: 'connected', auth: 'authenticated', login: 'completed' });
  expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toContain('synthetic-access-1');
  expire();
  expect(await invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'refreshed' } })).toMatchObject({ structuredContent: { text: 'refreshed' } });
  expect(counts.refresh).toBe(1); expect(counts.leakedGateway).toBe(0);
  expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toContain('synthetic-access-2');
  const previousGrant = await s.runtime.credentials.secret('extensions.mcp.fixture.oauth');
  await invoke(s, 'auth', { server: 'fixture' }); await invoke(s, 'auth.cancel', { server: 'fixture' });
  expect((await invoke(s, 'status')).servers[0].login).toBe('cancelled');
  expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toBe(previousGrant);
  await invoke(s, 'logout', { server: 'fixture' }); expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toBeUndefined();
}, 15_000);

it('rejects callback issuer mismatch without committing staged credentials or replaying the login', async () => {
  const { s, counts } = await authenticatedFixture();
  const login = await invoke(s, 'auth', { server: 'fixture' }), url = new URL(login.url), callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')!, iss: 'http://127.0.0.1:1' }).toString();
  expect((await fetch(callback)).status).toBe(400); expect(counts.code).toBe(0);
  expect(await s.runtime.credentials.secret('extensions.mcp.fixture.oauth')).toBeUndefined();
  expect((await invoke(s, 'status')).servers[0].login).toBe('failed');
});

it('never dispatches a late MCP call after cancellation during HTTP token refresh', async () => {
  const f = await authenticatedFixture(), login = await invoke(f.s, 'auth', { server: 'fixture' }), url = new URL(login.url), callback = new URL(url.searchParams.get('redirect_uri')!);
  f.challenge(url.searchParams.get('code_challenge')!);
  callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')!, iss: f.base }).toString();
  expect((await fetch(callback)).status).toBe(200);
  let resume = () => {}; f.pauseToken(() => new Promise<void>(resolve => { resume = resolve; })); f.expire();
  const controller = new AbortController(), context = { ownerId: f.s.config.ownerId, instanceId: f.s.config.instanceId, runId: crypto.randomUUID(), conversationId: '', source, mode: 'foreground' as const };
  const call = f.s.runtime.extensions.invoke('mcp_call', { server: 'fixture', name: 'read.echo', arguments: { text: 'must not arrive' } }, context, 'cancelled-refresh', async () => { throw new Error('Unexpected nested tool'); }, controller.signal, undefined, undefined, true).catch(error => error);
  try { await waitFor(() => f.counts.refresh === 1); controller.abort(new Error('synthetic cancellation')); expect(await call).toBeInstanceOf(Error); }
  finally { resume(); }
  await waitFor(() => f.counts.tokenReplies === 2); await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.counts.toolCalls).toBe(0);
});

it('supports explicit client-credentials grants without a browser or dynamic registration', async () => {
  const { s, counts } = await authenticatedFixture(true);
  expect((await invoke(s, 'connect', { server: 'fixture' })).servers[0].state).toBe('connected');
  expect(counts).toMatchObject({ machine: 1, registration: 0, code: 0, resource: true, leakedGateway: 0 });
  expect(await invoke(s, 'call', { server: 'fixture', name: 'read.echo', arguments: { text: 'machine' } })).toMatchObject({ structuredContent: { text: 'machine' } });
});
