import { afterEach, expect, it, vi } from 'vitest';
import { rmSync, readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { fauxProvider } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { ModelAccess } from '../src/models.js';
import { rpc } from '../src/daemon.js';
import { setup, source, waitFor } from './helpers.js';

const instances: ReturnType<typeof setup>[] = [];
const instance = () => { const s = setup(); instances.push(s); return s; };
afterEach(async () => { vi.useRealTimers(); for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function answerResponse(text: string) {
  const item = { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

it('registers the complete built-in Pi catalog, including independent Codex subscription auth', async () => {
  const s = instance(), access = new ModelAccess(s.runtime.credentials, s.config);
  expect(access.models.getProviders().map(provider => provider.id)).toEqual(builtinProviders().map(provider => provider.id));
  expect(access.providers()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'openai-codex', methods: [{ type: 'oauth', label: 'Sign in with an account' }] }),
    expect.objectContaining({ id: 'groq', methods: [{ type: 'api_key', label: 'Sign in with an API key' }] })
  ]));
  vi.stubEnv('OPENAI_API_KEY', 'must-not-use-environment'); vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-use-environment');
  expect(await access.models.getAuth('openai')).toBeUndefined(); expect(await access.models.getAuth('deepseek')).toBeUndefined();
  await rpc(s.runtime, { op: 'auth.key', args: { provider: 'openai', key: 'sk-fixture-api-only' } });
  expect(await access.models.getAuth('openai-codex')).toBeUndefined();
  await expect(rpc(s.runtime, { op: 'auth.select', args: { account: 'deepseek' } })).rejects.toThrow('OpenAI account');
});

it('uses Pi Codex device-code login and its actual streaming adapter without API-key fallback', async () => {
  const s = instance(), requests: Request[] = []; let refreshes = 0;
  const access = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64')}.signature`;
  await rpc(s.runtime, { op: 'auth.key', args: { provider: 'openai', key: 'sk-fixture-separate-api' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request.clone());
    if (request.url.endsWith('/deviceauth/usercode')) return jsonResponse({ device_auth_id: 'fixture-device', user_code: 'TEST-123', interval: '0' });
    if (request.url.endsWith('/deviceauth/token')) return jsonResponse({ authorization_code: 'fixture-code', code_verifier: 'fixture-verifier' });
    if (request.url === 'https://auth.openai.com/oauth/token') {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') === 'refresh_token') {
        expect(body.get('refresh_token')).toBe('fixture-codex-refresh'); refreshes++;
        return jsonResponse({ access_token: access, refresh_token: 'fixture-codex-rotated', expires_in: 3600 });
      }
      expect(body.get('grant_type')).toBe('authorization_code'); expect(body.get('code')).toBe('fixture-code'); expect(body.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
      return jsonResponse({ access_token: access, refresh_token: 'fixture-codex-refresh', expires_in: 3600 });
    }
    if (request.url === 'https://chatgpt.com/backend-api/codex/responses') {
      expect(request.headers.get('authorization')).toBe(`Bearer ${access}`); expect(request.headers.get('chatgpt-account-id')).toBe('fixture-account');
      const raw = Buffer.from(await request.arrayBuffer()), body = JSON.parse((request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw) : raw).toString());
      expect(body.store).toBe(false); expect(body.prompt_cache_key).toBeTruthy();
      return answerResponse('Fixture Codex answer');
    }
    throw new Error('Unexpected fixture request');
  });
  const login = s.runtime.auth.start('openai-codex', 'oauth');
  await waitFor(() => !!login.prompt);
  expect(login.prompt?.type).toBe('select'); expect((login.prompt as any).options.map((option: any) => option.id)).toEqual(['browser', 'device_code']);
  expect(() => s.runtime.auth.respond(login.id!, login.prompt!.id, 'invalid')).toThrow('Invalid login response');
  s.runtime.auth.respond(login.id!, login.prompt!.id, 'device_code');
  await waitFor(() => login.state !== 'pending'); expect(login.state).toBe('completed');
  expect(login.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'device_code', userCode: 'TEST-123' }) }));
  expect(requests).toHaveLength(3); // Authentication alone never runs a billed inference probe.
  expect(await s.runtime.credentials.read('openai-codex')).toMatchObject({ type: 'oauth', accountId: 'fixture-account', access });
  expect(await s.runtime.credentials.secret('openai.embeddingKey')).toBe('sk-fixture-separate-api');
  await s.runtime.credentials.modify('openai-codex', async credential => { if (credential?.type !== 'oauth') throw new Error('Missing fixture login'); return { ...credential, expires: Date.now() - 1 }; });
  const model = s.runtime.models.models.getModels('openai-codex')[0]!; s.config.model = { provider: model.provider, id: model.id };
  // Keep the wire fixture entirely on mocked fetch, never the real WebSocket transport.
  const options = s.runtime.models.options.bind(s.runtime.models);
  vi.spyOn(s.runtime.models, 'options').mockImplementation(async (...args) => ({ ...await options(...args), transport: 'sse' }));
  const conversation = s.runtime.newConversation(), run = await s.runtime.ingest({ requestId: 'codex-wire', conversationId: conversation.id, text: 'Hello' }, source);
  await waitFor(() => !['queued','running'].includes(s.runtime.run(run.id).status));
  expect(s.runtime.run(run.id), JSON.stringify(s.store.all('SELECT body FROM messages WHERE run_id=?', run.id))).toMatchObject({ status: 'completed', partial: 'Fixture Codex answer' });
  expect((await s.runtime.models.capabilities()).authentication).toBe('subscription'); expect(refreshes).toBe(1); expect(await s.runtime.credentials.read('openai-codex')).toMatchObject({ refresh: 'fixture-codex-rotated' });
  expect(statSync(s.runtime.credentials.path).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(login)).not.toContain(access); expect(s.store.all('SELECT * FROM messages').some(row => JSON.stringify(row).includes(access))).toBe(false);
  await rpc(s.runtime, { op: 'auth.logout', args: { provider: 'openai-codex' } });
  expect(await s.runtime.models.models.getAuth('openai-codex')).toBeUndefined(); expect(await s.runtime.credentials.secret('openai.mediaKey')).toBe('sk-fixture-separate-api');
});

it('uses Pi ChatGPT browser callbacks, state checks, token exchange and native subscription payloads', async () => {
  const s = instance(), localFetch = globalThis.fetch;
  await rpc(s.runtime, { op: 'auth.key', args: { provider: 'openai', key: 'sk-fixture-preserved-api' } });
  let exchanges = 0, calls = 0, refreshes = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const body = new URLSearchParams(await request.text()); expect(body.get('client_id')).toBe('fixture-issued-client');
      if (body.get('grant_type') === 'refresh_token') { expect(body.get('refresh_token')).toBe('fixture-chatgpt-refresh'); refreshes++; }
      else { expect(body.get('code')).toBe('fixture-browser-code'); expect(body.get('code_verifier')).toBeTruthy(); exchanges++; }
      return jsonResponse({ access_token: 'fixture-chatgpt-access', refresh_token: refreshes ? 'fixture-chatgpt-rotated' : 'fixture-chatgpt-refresh', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', id_token: 'fixture-id-token' });
    }
    if (request.url === 'https://api.openai.com/v1/responses') {
      calls++; expect(request.headers.get('authorization')).toBe('Bearer fixture-chatgpt-access');
      const body = await request.json(); expect(body.store).toBe(false); expect(body.stream).toBe(true); expect(body.max_output_tokens).toBeUndefined();
      expect(body.tools[0].type).toBe('function'); expect(body.tools[0].name).toBe('fixture_tool');
      return answerResponse('Fixture ChatGPT answer');
    }
    throw new Error('Unexpected fixture request');
  });
  const login = s.runtime.auth.start('openai', 'oauth', 'personal');
  await waitFor(() => !!login.prompt || login.state !== 'pending');
  expect(login.state, login.error).toBe('pending');
  const event = login.events.find(item => item.event.type === 'auth_url')!.event as { url: string };
  const url = new URL(event.url); expect(url.searchParams.get('agent_name_hint')).toBe('Pico'); expect(url.searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${s.config.instanceId}`);
  const redirect = new URL(url.searchParams.get('redirect_uri')!); redirect.search = new URLSearchParams({ code: 'fixture-browser-code', state: 'wrong-state', client_id: 'fixture-issued-client' }).toString();
  expect((await localFetch(redirect)).status).toBe(400); expect(exchanges).toBe(0); expect(login.state).toBe('pending');
  const oldPrompt = login.prompt!.id; redirect.searchParams.set('state', url.searchParams.get('state')!);
  expect((await localFetch(redirect)).status).toBe(200); await waitFor(() => login.state !== 'pending');
  expect(login.state).toBe('completed'); expect(login.prompt).toBeUndefined(); expect(exchanges).toBe(1); expect(calls).toBe(0);
  expect(() => s.runtime.auth.respond(login.id!, oldPrompt, 'late-secret')).toThrow('no longer active');
  expect(await s.runtime.credentials.activeAccount()).toBe('chatgpt:personal'); expect(await s.runtime.credentials.secret('openai.mediaKey')).toBe('sk-fixture-preserved-api');
  await s.runtime.credentials.modify('openai', async credential => { if (credential?.type !== 'oauth') throw new Error('Missing fixture login'); return { ...credential, expires: Date.now() - 1 }; });
  const reply = await s.runtime.models.complete({ systemPrompt: 'Fixture', messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }], tools: [{ name: 'fixture_tool', description: 'Fixture tool', parameters: { type: 'object', properties: {} } as any }] }, undefined, { provider: 'openai', id: 'gpt-4o-mini' });
  expect(reply.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Fixture ChatGPT answer' })); expect(calls).toBe(1); expect(refreshes).toBe(1); expect(await s.runtime.credentials.read('chatgpt:personal')).toMatchObject({ clientId: 'fixture-issued-client', refresh: 'fixture-chatgpt-rotated' });
  expect(readFileSync(s.runtime.credentials.path, 'utf8')).not.toContain('fixture-browser-code'); expect(s.store.meta('ownerId')).toBe(s.config.ownerId);
});

it('cancels provider prompts, rejects stale/foreign responses, hides provider errors and blocks reload while logging in', async () => {
  const s = instance(), faux = fauxProvider({ provider: 'login-fixture' });
  s.runtime.models.models.setProvider({ ...faux.provider, auth: { oauth: { name: 'Fixture subscription', login: async interaction => {
    await interaction.prompt({ type: 'secret', message: 'Fixture secret', signal: interaction.signal });
    throw new Error('fixture-secret-must-not-escape');
  }, refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }) } } });
  const login = s.runtime.auth.start('login-fixture', 'oauth'); await waitFor(() => !!login.prompt);
  expect(s.runtime.canApplySettings).toBe(false); expect(() => s.runtime.auth.start('deepseek', 'api_key')).toThrow('already pending');
  expect(() => s.runtime.auth.respond('foreign', login.prompt!.id, 'secret')).toThrow('not found');
  const promptId = login.prompt!.id; await s.runtime.auth.cancel(login.id!);
  expect(login.state).toBe('cancelled'); expect(login.prompt).toBeUndefined(); expect(s.runtime.canApplySettings).toBe(true);
  const next = s.runtime.auth.start('login-fixture', 'oauth'); await waitFor(() => !!next.prompt);
  expect(() => s.runtime.auth.respond(login.id!, promptId, 'stale')).toThrow('not found');
  s.runtime.auth.respond(next.id!, next.prompt!.id, 'fixture-secret-must-not-escape'); await waitFor(() => next.state !== 'pending');
  expect(next.state).toBe('failed'); expect(JSON.stringify(next)).not.toContain('fixture-secret-must-not-escape'); expect(await s.runtime.credentials.read('login-fixture')).toBeUndefined();
});

it('expires and shuts down pending login without persisting late provider results', async () => {
  const s = instance(), faux = fauxProvider({ provider: 'slow-login' });
  s.runtime.models.models.setProvider({ ...faux.provider, auth: { oauth: { name: 'Slow fixture', login: async interaction => {
    await interaction.prompt({ type: 'manual_code', message: 'Fixture callback' });
    return { type: 'oauth', access: 'late', refresh: 'late', expires: Date.now() + 3600_000 };
  }, refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }) } } });
  vi.useFakeTimers(); const login = s.runtime.auth.start('slow-login', 'oauth');
  await vi.advanceTimersByTimeAsync(900_000); expect(login.state).toBe('expired'); expect(await s.runtime.credentials.read('slow-login')).toBeUndefined();
  const next = s.runtime.auth.start('slow-login', 'oauth'); await s.runtime.auth.close();
  expect(next.state).toBe('cancelled'); expect(() => s.runtime.auth.start('slow-login', 'oauth')).toThrow('shutting down');
});

it('preserves successful login when the Pi-owned model catalog refresh fails, without exposing provider errors', async () => {
  const s = instance(), faux = fauxProvider({ provider: 'catalog-fixture' });
  s.runtime.models.models.setProvider({ ...faux.provider, auth: { oauth: { name: 'Catalog fixture', login: async () => ({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600_000 }), refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }) } }, refreshModels: async context => { if (context.allowNetwork) throw new Error('fixture-secret-in-catalog-error'); } });
  const login = s.runtime.auth.start('catalog-fixture', 'oauth'); await waitFor(() => login.state !== 'pending');
  expect(login.state).toBe('completed'); expect(await s.runtime.credentials.read('catalog-fixture')).toMatchObject({ type: 'oauth', access: 'fixture-access' });
  expect(login.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'info', message: expect.stringContaining('catalog could not refresh') }) })); expect(JSON.stringify(login)).not.toContain('fixture-secret-in-catalog-error');
});

it('cancellation during catalog refresh settles login without pretending accepted credential writes were undone', async () => {
  const s = instance(), faux = fauxProvider({ provider: 'catalog-cancel' }); let refreshing = false;
  s.runtime.models.models.setProvider({ ...faux.provider, auth: { oauth: { name: 'Cancel fixture', login: async () => ({ type: 'oauth', access: 'fixture-accepted', refresh: 'fixture-refresh', expires: Date.now() + 3600_000 }), refresh: async credential => credential, toAuth: async credential => ({ apiKey: credential.access }) } }, refreshModels: async context => { if (context.allowNetwork) { refreshing = true; await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true })); } } });
  const login = s.runtime.auth.start('catalog-cancel', 'oauth'); await waitFor(() => refreshing); await s.runtime.auth.cancel(login.id!);
  expect(login.state).toBe('cancelled'); expect(s.runtime.canApplySettings).toBe(true); expect(await s.runtime.credentials.read('catalog-cancel')).toMatchObject({ access: 'fixture-accepted' });
});

it('an aborted login waiting for the vault lock cannot overwrite existing credentials', async () => {
  const s = instance(); let release!: () => void;
  await s.runtime.credentials.modify('openai-api', async () => ({ type: 'api_key', key: 'sk-fixture-existing' })); await s.runtime.credentials.selectOpenai('openai-api');
  const locked = s.runtime.credentials.modify('fixture-lock', async () => { await new Promise<void>(resolve => { release = resolve; }); return { type: 'api_key', key: 'fixture' }; });
  await waitFor(() => !!release);
  const controller = new AbortController();
  const login = s.runtime.models.login('openai', 'api_key', { signal: controller.signal, prompt: async () => 'sk-cancelled', notify() {} });
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
  await expect(login).rejects.toThrow(); release(); await locked;
  await expect(s.runtime.models.models.logout('openai', { signal: controller.signal })).rejects.toThrow();
  await expect(s.runtime.credentials.alias('openai', 'openai-api').delete('openai', { signal: controller.signal })).rejects.toThrow();
  expect(await s.runtime.credentials.read('openai-api')).toMatchObject({ key: 'sk-fixture-existing' }); expect(await s.runtime.credentials.activeAccount()).toBe('openai-api');
});
