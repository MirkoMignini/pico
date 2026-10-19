import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import initializeDownloads, { captureResponse, collectedDownloads, type DownloadSession } from '../src/browser-downloads.js';
import { BRIDGE_FILE_BYTES } from '../src/browser-bridge-contracts.js';

const directories: string[] = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'pikobot-download-test-')); directories.push(value); return value; };
const event = () => ({ requestId: 'synthetic-request', request: { url: 'https://synthetic.invalid/file' }, resourceType: 'Document', responseStatusCode: 200, responseHeaders: [{ name: 'Content-Disposition', value: 'attachment; filename="report.csv"' }, { name: 'Content-Type', value: 'text/csv; charset=utf-8' }] });
function session(chunks = [Buffer.from('kind,value\nsynthetic,7\n')]) {
  let index = 0;
  const send = vi.fn<DownloadSession['send']>(async method => {
    if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'synthetic-stream' };
    if (method === 'IO.read') return { data: chunks[index++]!.toString('base64'), base64Encoded: true, eof: index === chunks.length };
    return {};
  });
  return { send, on: vi.fn(), off: vi.fn(), listeners: vi.fn(() => [vi.fn()]), detach: vi.fn(async () => {}) } satisfies DownloadSession & { off: unknown; listeners: unknown };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('captures exact bounded streamed bytes once, preserves browser delivery and publishes a private generated filename', async () => {
  const root = directory(), bytes = Buffer.from([0, 255, 128, 13, 10]), client = session([bytes.subarray(0, 2), bytes.subarray(2)]), response = event();
  response.responseHeaders.push({ name: 'Content-Encoding', value: 'gzip' }, { name: 'Transfer-Encoding', value: 'chunked' });
  response.responseHeaders[0]!.value = "attachment; filename*=UTF-8''..%2FQuarter%20one.csv";
  await captureResponse(client, response, root);
  const captured = collectedDownloads(root);
  expect(captured.pending).toBe(0); expect(captured.errors).toEqual([]); expect(captured.files).toHaveLength(1);
  const file = captured.files[0]!;
  expect(file).toMatchObject({ name: 'Quarter one.csv', mimeType: 'text/csv' });
  expect(file.file).toMatch(/^download-[a-f0-9-]{36}\.csv$/);
  expect(readFileSync(join(root, file.file))).toEqual(bytes);
  const fulfill = client.send.mock.calls.find(([method]) => method === 'Fetch.fulfillRequest')!;
  expect(fulfill[1]).toMatchObject({ requestId: response.requestId, responseCode: 200, body: bytes.toString('base64'), responseHeaders: expect.arrayContaining([{ name: 'Content-Length', value: '5' }]) });
  expect(JSON.stringify(fulfill[1])).not.toMatch(/Content-Encoding|Transfer-Encoding/);
  expect(client.send.mock.calls.filter(([method]) => method === 'Fetch.takeResponseBodyAsStream')).toHaveLength(1);
  expect(client.send.mock.calls.map(([method]) => method)).not.toContain('Network.loadNetworkResource');
  expect(client.send.mock.calls.map(([method]) => method)).toContain('IO.close');
});

it('attaches only a tab-scoped Fetch session and never changes browser-global download behavior', async () => {
  const root = directory(), client = session(), page = { url: () => 'about:blank', _connection: { toImpl: () => ({ delegate: { _mainFrameSession: { _client: client }, _networkManager: { _protocolRequestInterceptionEnabled: false } } }) }, on: vi.fn() };
  vi.stubEnv('PIKOBOT_BROWSER_DOWNLOAD_DIR', root);
  await initializeDownloads({ page });
  expect(client.send).toHaveBeenCalledWith('Fetch.enable', { patterns: ['Document', 'Other'].map(resourceType => ({ urlPattern: '*', resourceType, requestStage: 'Response' })) });
  expect(client.on).toHaveBeenCalledWith('Fetch.requestPaused', expect.any(Function));
  expect(JSON.stringify(client.send.mock.calls)).not.toContain('Browser.setDownloadBehavior');
  await initializeDownloads({ page: { ...page, url: () => 'chrome-extension://synthetic/status.html' } });
  expect(client.send).toHaveBeenCalledTimes(1);
});

it('preserves native request-stage handlers, restores them on close and never detaches the owner session', async () => {
  const root = directory(), client = session(), native = vi.fn(); client.listeners.mockReturnValue([native]); let close = () => {};
  vi.stubEnv('PIKOBOT_BROWSER_DOWNLOAD_DIR', root);
  const page = { url: () => 'about:blank', _connection: { toImpl: () => ({ delegate: { _mainFrameSession: { _client: client }, _networkManager: { _protocolRequestInterceptionEnabled: false } } }) }, on: (name: string, callback: () => void) => { if (name === 'close') close = callback; } };
  await initializeDownloads({ page });
  const paused = client.on.mock.calls[0]![1], request = { ...event(), responseStatusCode: undefined };
  paused(request); expect(native).toHaveBeenCalledExactlyOnceWith(request);
  close(); expect(client.off).toHaveBeenCalledWith('Fetch.requestPaused', paused);
  expect(client.on).toHaveBeenLastCalledWith('Fetch.requestPaused', native);
  expect(client.send).toHaveBeenLastCalledWith('Fetch.disable'); expect(client.detach).not.toHaveBeenCalled();
});

it('refuses unsupported vendor internals or active request routing instead of broadening CDP permissions', async () => {
  vi.stubEnv('PIKOBOT_BROWSER_DOWNLOAD_DIR', directory()); const client = session();
  await expect(initializeDownloads({ page: { url: () => 'about:blank', on: vi.fn() } })).rejects.toThrow('reviewed in-process');
  const delegate = { _mainFrameSession: { _client: client }, _networkManager: { _protocolRequestInterceptionEnabled: true } };
  const page = { url: () => 'about:blank', _connection: { toImpl: () => ({ delegate }) }, on: vi.fn() };
  await expect(initializeDownloads({ page })).rejects.toThrow('without request routing'); expect(client.off).not.toHaveBeenCalled();
  delegate._networkManager._protocolRequestInterceptionEnabled = false; client.listeners.mockReturnValue([]);
  await expect(initializeDownloads({ page })).rejects.toThrow('Unsupported Playwright Fetch listeners'); expect(client.send).not.toHaveBeenCalled();
});

it('installs capture after an internal Chrome tab becomes a webpage', async () => {
  const root = directory(), client = session(); let url = 'chrome://newtab', navigate = () => {};
  vi.stubEnv('PIKOBOT_BROWSER_DOWNLOAD_DIR', root);
  const page = { url: () => url, _connection: { toImpl: () => ({ delegate: { _mainFrameSession: { _client: client }, _networkManager: { _protocolRequestInterceptionEnabled: false } } }) }, on: vi.fn((name: string, callback: () => void) => { if (name === 'framenavigated') navigate = callback; }) };
  await initializeDownloads({ page }); expect(client.send).not.toHaveBeenCalled();
  url = 'https://synthetic.invalid/'; navigate(); await new Promise(resolve => setImmediate(resolve));
  expect(client.send).toHaveBeenCalledWith('Fetch.enable', expect.any(Object));
  navigate(); expect(client.send).toHaveBeenCalledTimes(1);
});

it.each(['html', 'xhr', 'partial', 'redirect', 'file'])('continues unsupported %s responses without capturing or refetching', async kind => {
  const root = directory(), client = session(), response = event();
  if (kind === 'html') response.responseHeaders[0]!.value = 'inline';
  if (kind === 'xhr') response.resourceType = 'XHR';
  if (kind === 'partial') response.responseStatusCode = 206;
  if (kind === 'redirect') response.responseStatusCode = 302;
  if (kind === 'file') response.request.url = 'file:///private/secret.csv';
  await captureResponse(client, response, root);
  expect(client.send.mock.calls).toEqual([['Fetch.continueResponse', { requestId: response.requestId }]]);
  expect(readdirSync(root)).toEqual([]);
});

it.each(['declared', 'streamed'])('rejects %s oversize transfers without publishing a partial file', async kind => {
  const root = directory(), client = session(), response = event();
  if (kind === 'declared') response.responseHeaders.push({ name: 'Content-Length', value: String(BRIDGE_FILE_BYTES + 1) });
  else client.send.mockImplementation(async method => method === 'Fetch.takeResponseBodyAsStream' ? { stream: 'stream' } : method === 'IO.read' ? { data: Buffer.alloc(64_000).toString('base64'), base64Encoded: true, eof: false } : {});
  await captureResponse(client, response, root);
  expect(collectedDownloads(root)).toEqual({ files: [], pending: 0, errors: ['size-limit'] });
  expect(client.send.mock.calls.map(([method]) => method)).not.toContain('Fetch.fulfillRequest');
  expect(client.send.mock.calls.map(([method]) => method)).toContain('Fetch.failRequest');
});

it.each(['invalid-base64', 'stalled', 'failed-fulfillment'])('fails closed for %s and never publishes bytes as completed', async kind => {
  const root = directory(), client = session();
  client.send.mockImplementation(async method => {
    if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'stream' };
    if (method === 'IO.read') return kind === 'invalid-base64' ? { data: '!!!', base64Encoded: true, eof: true } : kind === 'stalled' ? { data: '', eof: false } : { data: 'data', eof: true };
    if (method === 'Fetch.fulfillRequest') throw new Error('Synthetic lost acknowledgement');
    return {};
  });
  await captureResponse(client, event(), root);
  expect(collectedDownloads(root)).toEqual({ files: [], pending: 0, errors: ['transfer-failed'] });
  expect(readdirSync(root)).toEqual([]);
});

it('times out without late publication, refetch or waiting indefinitely for cleanup acknowledgements', async () => {
  vi.useFakeTimers(); const root = directory(), client = session(); let complete!: (result: Record<string, unknown>) => void;
  client.send.mockImplementation(async method => {
    if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'stream' };
    if (method === 'IO.read') return new Promise(resolve => { complete = resolve; });
    if (method === 'IO.close' || method === 'Fetch.failRequest') return new Promise(() => {});
    return {};
  });
  const work = captureResponse(client, event(), root);
  await vi.advanceTimersByTimeAsync(30_001); await work;
  expect(collectedDownloads(root)).toEqual({ files: [], pending: 0, errors: ['transfer-failed'] });
  complete({ data: 'late bytes', eof: true }); await vi.advanceTimersByTimeAsync(1);
  expect(readdirSync(root)).toEqual([]);
  expect(client.send.mock.calls.map(([method]) => method)).not.toContain('Fetch.fulfillRequest');
});

it('bounds staged transfers and rejects forged sidecar paths, identity mismatches and links', async () => {
  const root = directory(), client = session();
  for (let i = 0; i < 16; i++) writeFileSync(join(root, `.pikobot-download-${randomUUID()}.pending`), '');
  await captureResponse(client, event(), root);
  expect(collectedDownloads(root).errors).toEqual(['queue-full']);
  expect(client.send.mock.calls.map(([method]) => method)).not.toContain('Fetch.takeResponseBodyAsStream');
  const id = randomUUID(), control = join(root, `.pikobot-download-${id}.json`);
  writeFileSync(control, JSON.stringify({ file: '../../secret.csv', name: 'data', mimeType: 'text/csv' }));
  expect(() => collectedDownloads(root)).toThrow('Invalid input');
  writeFileSync(control, JSON.stringify({ file: `download-${randomUUID()}.csv`, name: 'data', mimeType: 'text/csv' }));
  expect(() => collectedDownloads(root)).toThrow('identity mismatch');
  rmSync(control); writeFileSync(join(root, 'target'), '{}'); symlinkSync(join(root, 'target'), control);
  expect(() => collectedDownloads(root)).toThrow('not links');
});
