import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createServer as createForwarder, connect as connectTcp, type Socket } from 'node:net';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { atomicWrite } from '../src/config.js';
import { initializeBrowserBridge, serveBrowserBridge, browserBridgePairing, browserBridgeConfig } from '../src/browser-bridge.js';
import { remoteBrowserSettings, BROWSER_TOOLS } from '../src/mcp-browser.js';
import { rpc } from '../src/daemon.js';
import { Credentials } from '../src/credentials.js';
import { setup, waitFor } from './helpers.js';

const directories: string[] = [], cleanups: (() => Promise<void>)[] = [], instances: ReturnType<typeof setup>[] = [];
const entrypoint = fileURLToPath(new URL('./fixtures/mcp-browser-server.mjs', import.meta.url));
const extensionToken = 'synthetic-extension-token-for-test-only';
const invoke = <T = any>(s: ReturnType<typeof setup>, name: string, args: Record<string, unknown> = {}): Promise<T> => rpc(s.runtime, { op: `extensions.mcp.${name}`, args }) as Promise<T>;
async function desktop() {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const root = mkdtempSync(join(tmpdir(), 'pikobot-bridge-test-')); directories.push(root);
  const config = await initializeBrowserBridge(root, entrypoint, 'Default', port, extensionToken);
  const bridge = await serveBrowserBridge(root); cleanups.push(bridge.close);
  const pairing = await browserBridgePairing(root, bridge.url);
  return { root, config, bridge, pairing, headers: { Authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' } };
}
async function server(d: Awaited<ReturnType<typeof desktop>>) {
  const s = setup('synthetic-remote-owner'); instances.push(s); await s.runtime.start();
  const selected = remoteBrowserSettings({ servers: [] }, d.pairing);
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: selected.settings } });
  await rpc(s.runtime, { op: 'extensions.secret', args: { id: 'mcp', name: 'browser-remote', value: JSON.stringify({ headers: { Authorization: d.headers.Authorization } }) } });
  await invoke(s, 'connect', { server: 'browser-remote' }); return s;
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('initializes only a separate private bridge vault, pins an explicit Chrome profile and never touches owner profiles', async () => {
  const d = await desktop();
  expect(browserBridgeConfig(d.root)).toMatchObject({ id: d.config.id, profile: 'Default', entrypoint });
  expect(lstatSync(join(d.root, 'bridge.json')).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(d.root, 'secrets.json')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(d.root, 'bridge.json'), 'utf8')).not.toContain(extensionToken);
  expect(JSON.stringify(d.pairing)).not.toContain(extensionToken);
  expect(await new Credentials(d.root).secret('browser.extensionToken')).toBe(extensionToken);
  await expect(initializeBrowserBridge(d.root, entrypoint, 'Default', d.config.port, extensionToken)).rejects.toThrow('empty');
  await expect(initializeBrowserBridge(join(d.root, 'other'), entrypoint, '../personal', d.config.port, extensionToken)).rejects.toThrow('Invalid input');
  expect(existsSync(join(d.root, 'profile'))).toBe(false);
});

it('never overwrites authority when two initializations race for the same empty directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pikobot-bridge-race-')); directories.push(root);
  const attempts = await Promise.allSettled(['Default', 'Profile 2'].map(profile => initializeBrowserBridge(root, entrypoint, profile, 8931, extensionToken)));
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const winner = attempts.find(result => result.status === 'fulfilled')!;
  if (winner.status === 'fulfilled') expect(browserBridgeConfig(root)).toEqual(winner.value);
  expect((await browserBridgePairing(root, 'http://127.0.0.1:8931/mcp')).bridgeId).toBe(browserBridgeConfig(root).id);
});

it('requires bearer authentication and rejects browser origins, hostile Host headers, non-MCP paths and oversized requests', async () => {
  const d = await desktop();
  expect((await fetch(d.bridge.url, { method: 'POST', body: '{}' })).status).toBe(401);
  expect((await fetch(d.bridge.url, { method: 'POST', headers: { ...d.headers, Authorization: `Bearer ${'x'.repeat(43)}` }, body: '{}' })).status).toBe(401);
  expect((await fetch(d.bridge.url, { method: 'POST', headers: { ...d.headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
  const hostileHost = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(d.bridge.url, { method: 'POST', headers: { ...d.headers, Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode!); });
    request.once('error', reject); request.end('{}');
  });
  expect(hostileHost).toBe(403);
  expect((await fetch(d.bridge.url.replace('/mcp', '/rpc'), { method: 'POST', headers: d.headers, body: '{}' })).status).toBe(404);
  expect((await fetch(d.bridge.url, { method: 'POST', headers: d.headers, body: 'x'.repeat(1_000_001) })).status).toBe(413);
  const s = await server(d);
  const nav = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_navigate', arguments: { url: 'https://synthetic.invalid' } });
  expect(JSON.parse(nav.content[0].text).navigations).toBe(1);
});

it('configures an exact autonomous tunnel endpoint without overwriting local servers, exposing secrets or accepting public URLs', async () => {
  const d = await desktop();
  const existing = { id: 'browser', enabled: false, transport: 'stdio', command: '/usr/bin/false' };
  const selected = remoteBrowserSettings({ servers: [existing] }, d.pairing);
  expect(selected.settings.servers[0]).toEqual(existing);
  expect(selected.settings.servers[1]).toMatchObject({ id: 'browser-remote', transport: 'http', browserBridgeId: d.config.id, allowPrivateNetwork: true, autonomousTools: BROWSER_TOOLS });
  expect(JSON.stringify(selected.settings)).not.toContain(d.pairing.token);
  expect(() => remoteBrowserSettings(selected.settings, d.pairing)).toThrow('already exists');
  for (const url of ['http://public.example/mcp', 'https://public.example/mcp', 'http://127.0.0.1/rpc', 'http://127.0.0.1/mcp?token=secret', 'http://user:pass@127.0.0.1/mcp']) expect(() => remoteBrowserSettings({ servers: [] }, { ...d.pairing, url })).toThrow();
  expect(() => remoteBrowserSettings({ servers: [] }, { ...d.pairing, extra: true })).toThrow('Invalid browser bridge pairing');
  expect(() => remoteBrowserSettings({ servers: [] }, { ...d.pairing, [d.pairing.token]: true })).toThrow(/^Invalid browser bridge pairing; expected only version, bridgeId, url and token$/);
});

it('uses authenticated HTTP through an actual TCP forwarder and owned stdio to recover remote bytes, not server host paths', async () => {
  const d = await desktop(), sockets = new Set<Socket>();
  const forward = createForwarder(front => {
    const back = connectTcp(d.config.port, '127.0.0.1');
    for (const socket of [front, back]) { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); front.destroy(); back.destroy(); }); socket.once('error', () => { front.destroy(); back.destroy(); }); }
    front.pipe(back); back.pipe(front);
  });
  forward.listen(0, '127.0.0.1'); await once(forward, 'listening');
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => forward.close(() => resolve())); });
  const url = `http://127.0.0.1:${(forward.address() as { port: number }).port}/mcp`;
  const s = await server({ ...d, pairing: { ...d.pairing, url } });
  const snapshot = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: {} });
  expect(snapshot.prepared).not.toBe(true);
  expect(snapshot.browserArtifacts).toHaveLength(1);
  const read = await invoke(s, 'artifact', { server: 'browser-remote', sourceId: snapshot.originalResultSourceId, file: 'page.yml' });
  expect(read.text).toContain('[ref=e2]');
  expect(existsSync(join(s.root, 'page.yml'))).toBe(false);
  const download = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_pdf_save', arguments: {} });
  const imported = await invoke(s, 'import', { server: 'browser-remote', sourceId: download.originalResultSourceId, file: 'report.pdf' });
  expect(Buffer.from((await s.runtime.media.read(imported.attachmentId)).bytes).toString()).toContain('Synthetic browser download');
  expect(s.runtime.knowledge.document(imported.documentId).source_id).toBe(download.originalResultSourceId);
  await expect(invoke(s, 'resource', { server: 'browser-remote', uri: 'file:///etc/passwd' })).rejects.toThrow();
  await expect(invoke(s, 'import', { server: 'browser-remote', sourceId: download.originalResultSourceId, file: '../secrets.json' })).rejects.toThrow();
  for (const name of ['browser_evaluate', 'browser_run_code', 'browser_file_upload']) await expect(invoke(s, 'call', { server: 'browser-remote', name, arguments: {} })).rejects.toThrow('not enabled');
  expect((await invoke(s, 'actions.list')).total).toBe(0);
  expect(s.faux.state.callCount).toBe(0);
  await s.runtime.deleteKnowledge(imported.documentId, true);
  expect(s.runtime.memory.source(download.originalResultSourceId)).toBeUndefined();
  expect(s.store.all('SELECT id FROM attachments')).toEqual([]);
});

it('pins tab-captured HTTP attachments even when the backend reports no filename, then imports exactly those receipt-bound bytes', async () => {
  const d = await desktop(), s = await server(d);
  const download = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_navigate', arguments: { url: 'bridge-http-download' } });
  expect(download.browserArtifacts).toHaveLength(1);
  const file = download.browserArtifacts[0];
  expect(file).toMatchObject({ name: expect.stringMatching(/^download-[a-f0-9-]{36}\.csv$/), mimeType: 'text/csv', bytes: 23 });
  const imported = await invoke(s, 'import', { server: 'browser-remote', sourceId: download.originalResultSourceId, file: file.name, mime: file.mimeType });
  expect(Buffer.from((await s.runtime.media.read(imported.attachmentId)).bytes).toString()).toBe('kind,value\nsynthetic,7\n');
  expect(s.runtime.knowledge.document(imported.documentId).source_id).toBe(download.originalResultSourceId);
  await expect(invoke(s, 'import', { server: 'browser-remote', sourceId: download.originalResultSourceId, file: 'report.csv' })).rejects.toThrow('Remote artifact is missing');
  expect((await invoke(s, 'actions.list')).total).toBe(0); expect(s.faux.state.callCount).toBe(0);
});

it('refuses wrong bridge identity/credentials and never silently forwards old credentials to a replacement pairing', async () => {
  const d = await desktop(), s = await server(d);
  const settings = (await rpc(s.runtime, { op: 'extensions.setup', args: { id: 'mcp' } }) as any).settings;
  settings.servers[0].browserBridgeId = crypto.randomUUID();
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings } });
  await expect(invoke(s, 'connect', { server: 'browser-remote' })).rejects.toThrow('failed');
  await rpc(s.runtime, { op: 'extensions.secret', args: { id: 'mcp', name: 'browser-remote', value: JSON.stringify({ headers: { Authorization: d.headers.Authorization } }) } });
  await expect(invoke(s, 'connect', { server: 'browser-remote' })).rejects.toThrow('failed');
});

it('redacts bridge credentials, scrubs unrelated environment and does not trust backend-minted artifact handles', async () => {
  vi.stubEnv('PIKOBOT_BRIDGE_AMBIENT_TOKEN', 'must-not-reach-browser'); vi.stubEnv('WAYLAND_DISPLAY', 'synthetic-wayland');
  const d = await desktop(), s = await server(d);
  const inspect = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_navigate', arguments: { url: 'bridge-inspect' } });
  const details = JSON.parse(inspect.content[0].text);
  expect(details).toMatchObject({ extensionToken: '[redacted]', inherited: null, wayland: 'synthetic-wayland' });
  expect(details.args).toEqual(expect.arrayContaining(['--extension', '--profile-dir-name', 'Default']));
  expect(details.args).not.toContain('--user-data-dir');
  expect(JSON.stringify(inspect)).not.toContain(d.pairing.token);
  const forged = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_navigate', arguments: { url: 'bridge-forged-artifact' } });
  expect(forged.browserArtifacts).toEqual([]);
  await expect(invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: { url: 'bridge-secret-file' } })).rejects.toThrow('uncertain');
  expect(JSON.stringify(s.store.all('SELECT result FROM operations'))).not.toContain(extensionToken);
  expect(Number.isSafeInteger(details.pid)).toBe(true); process.kill(details.pid, 0);
  await d.bridge.close(); await waitFor(() => { try { process.kill(details.pid, 0); return false; } catch { return true; } });
});

it('pins remote artifact bytes even when the backend later overwrites the same filename', async () => {
  const d = await desktop(), s = await server(d);
  const original = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: {} });
  const staged = /^\[Snapshot\]\((.+)\)$/.exec(original.content[0].text)?.[1];
  expect(staged).toContain('/pikobot-browser-bridge-'); expect(existsSync(staged!)).toBe(false);
  const changed = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: { url: 'changed' } });
  const first = await invoke(s, 'artifact', { server: 'browser-remote', sourceId: original.originalResultSourceId, file: 'page.yml' });
  const second = await invoke(s, 'artifact', { server: 'browser-remote', sourceId: changed.originalResultSourceId, file: 'page.yml' });
  expect(first.text).toContain('[ref=e2]'); expect(second.text).toBe('Changed synthetic snapshot');
  expect(first.hash).not.toBe(second.hash);
});

it('blocks profile/configuration changes from inheriting an existing bridge pairing', async () => {
  const d = await desktop();
  atomicWrite(join(d.root, 'bridge.json'), JSON.stringify({ ...d.config, profile: 'Other Profile' }));
  await expect(browserBridgePairing(d.root, d.bridge.url)).rejects.toThrow('changed');
  await expect(serveBrowserBridge(d.root)).rejects.toThrow('changed');
});

it('does not resurrect an import when source erasure races an in-flight remote artifact read', async () => {
  const d = await desktop(), s = await server(d);
  const snapshot = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: {} });
  const args = { server: 'browser-remote', sourceId: snapshot.originalResultSourceId, file: 'page.yml' };
  const first = await invoke(s, 'import', { ...args, mime: 'text/plain' });
  let received = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), original = McpClient.prototype.readResource;
  vi.spyOn(McpClient.prototype, 'readResource').mockImplementation(async function (this: McpClient, ...input) { const result = await original.apply(this, input); received = true; await gate; return result; });
  const importing = invoke(s, 'import', { ...args, mime: 'text/markdown' }).catch(error => error);
  try { await waitFor(() => received); await s.runtime.deleteKnowledge(first.documentId, true); }
  finally { release(); }
  expect(await importing).toBeInstanceOf(Error);
  expect(s.store.all('SELECT id FROM attachments')).toEqual([]);
  expect(s.store.all('SELECT id FROM documents WHERE deleted_at IS NULL')).toEqual([]);
});

it('verifies remote byte integrity and refuses artifacts acquired under a previous credential binding', async () => {
  const d = await desktop(), s = await server(d);
  const snapshot = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: {} });
  const args = { server: 'browser-remote', sourceId: snapshot.originalResultSourceId, file: 'page.yml' }, original = McpClient.prototype.readResource;
  const corrupt = vi.spyOn(McpClient.prototype, 'readResource').mockImplementation(async function (this: McpClient, ...input) { const result = await original.apply(this, input); return { ...result, contents: result.contents.map(content => ({ ...content, blob: Buffer.alloc(snapshot.browserArtifacts[0].bytes).toString('base64') })) }; });
  await expect(invoke(s, 'import', args)).rejects.toThrow('integrity'); corrupt.mockRestore();
  await rpc(s.runtime, { op: 'extensions.secret', args: { id: 'mcp', name: 'browser-remote', value: JSON.stringify({ headers: { Authorization: d.headers.Authorization, 'X-Bridge-Revision': 'new' } }) } });
  await expect(invoke(s, 'import', args)).rejects.toThrow();
  expect(s.store.all('SELECT id FROM attachments')).toEqual([]);
});

it('evicts old resource handles without retaining every staged snapshot or replaying effects', async () => {
  const d = await desktop(), s = await server(d);
  let first: any, last: any;
  for (let index = 0; index < 65; index++) { last = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: {} }); first ??= last; }
  await expect(invoke(s, 'artifact', { server: 'browser-remote', sourceId: first.originalResultSourceId, file: 'page.yml' })).rejects.toThrow();
  expect((await invoke(s, 'artifact', { server: 'browser-remote', sourceId: last.originalResultSourceId, file: 'page.yml' })).text).toContain('[ref=e2]');
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_autonomous'")).toEqual({ count: 65 });
});

it('preserves uncertainty after backend loss instead of restarting and replaying it', async () => {
  const d = await desktop(), s = await server(d);
  await expect(invoke(s, 'call', { server: 'browser-remote', name: 'browser_navigate', arguments: { url: 'lost-ack' } })).rejects.toThrow('uncertain');
  await invoke(s, 'disconnect', { server: 'browser-remote' });
  await expect(invoke(s, 'connect', { server: 'browser-remote' })).rejects.toThrow();
  expect(s.store.get("SELECT status FROM operations WHERE tool='mcp_autonomous'")).toEqual({ status: 'uncertain' });
  expect((await invoke(s, 'actions.list')).total).toBe(0);
});

it('expires remote artifact handles on bridge restart without replaying a browser action', async () => {
  const d = await desktop(), s = await server(d);
  const snapshot = await invoke(s, 'call', { server: 'browser-remote', name: 'browser_snapshot', arguments: {} });
  await invoke(s, 'disconnect', { server: 'browser-remote' }); await d.bridge.close();
  const replacement = await serveBrowserBridge(d.root); cleanups.push(replacement.close);
  await invoke(s, 'connect', { server: 'browser-remote' });
  await expect(invoke(s, 'artifact', { server: 'browser-remote', sourceId: snapshot.originalResultSourceId, file: 'page.yml' })).rejects.toThrow();
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_autonomous'")).toEqual({ count: 1 });
  expect((await invoke(s, 'actions.list')).total).toBe(0);
});
