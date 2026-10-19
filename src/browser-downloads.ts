import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Type, type Static } from 'typebox';
import { object, validate } from './contracts.js';
import { atomicWrite, existingPrivateDirectory } from './config.js';
import { safeName } from './media.js';
import { readRegular } from './skill-package.js';
import { BRIDGE_FILE_BYTES } from './browser-bridge-contracts.js';

const idPattern = '[a-f0-9-]{36}';
const controlPattern = new RegExp(`^\\.pikobot-download-(${idPattern})\\.(json|pending|error)$`);
export const CapturedDownloadSchema = object({ file: Type.String({ pattern: `^download-${idPattern}\\.[a-z0-9]{1,12}$` }), name: Type.String({ minLength: 1, maxLength: 120 }), mimeType: Type.String({ minLength: 1, maxLength: 100 }) });
export type CapturedDownload = Static<typeof CapturedDownloadSchema>;
interface PausedResponse { requestId: string; request: { url: string }; resourceType: string; responseStatusCode?: number; responseErrorReason?: string; responseHeaders?: { name: string; value: string }[] }
export interface DownloadSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: 'Fetch.requestPaused', callback: (event: PausedResponse) => void): unknown;
  detach(): Promise<void>;
}
type PausedHandler = (event: PausedResponse) => void;
interface TabSession extends DownloadSession { listeners(event: 'Fetch.requestPaused'): PausedHandler[]; off(event: 'Fetch.requestPaused', callback: PausedHandler): unknown }
interface DownloadPage {
  url(): string;
  _connection?: { toImpl?: (page: DownloadPage) => { delegate?: { _mainFrameSession?: { _client?: TabSession }; _networkManager?: { _protocolRequestInterceptionEnabled?: boolean } } } };
  on(event: 'close' | 'framenavigated', callback: () => void): unknown;
}
const ChunkSchema = object({ data: Type.String({ maxLength: 90_000 }), base64Encoded: Type.Optional(Type.Boolean()), eof: Type.Optional(Type.Boolean()) });
const ErrorSchema = Type.Union(['size-limit', 'queue-full', 'transfer-failed'].map(value => Type.Literal(value)));
const chunkBytes = 64_000;

/** Installed by Playwright's trusted --init-page hook, never exposed as model-supplied code. */
export default async function initializeDownloads({ page }: { page: DownloadPage }): Promise<void> {
  const directory = process.env.PIKOBOT_BROWSER_DOWNLOAD_DIR;
  if (!directory) throw new Error('Private browser download directory missing');
  existingPrivateDirectory(directory);
  const failed = () => { try { atomicWrite(join(directory, '.pikobot-download-initialization.error'), JSON.stringify('transfer-failed')); } catch {} };
  if (/^(chrome|chrome-extension|devtools):/.test(page.url())) {
    let started = false;
    page.on('framenavigated', () => {
      if (started || /^(chrome|chrome-extension|devtools):/.test(page.url())) return;
      started = true; void initializeDownloads({ page }).catch(failed);
    });
    return;
  }
  // shortcut: MCP 0.0.83 forbids browser-level CDP; borrow its owned in-process tab session until upstream exposes one.
  const delegate = page._connection?.toImpl?.(page)?.delegate, session = delegate?._mainFrameSession?._client;
  if (!session || delegate?._networkManager?._protocolRequestInterceptionEnabled !== false || typeof session.listeners !== 'function' || typeof session.off !== 'function') throw new Error('Download capture requires the reviewed in-process Playwright tab connection without request routing');
  const original = session.listeners('Fetch.requestPaused');
  if (original.length !== 1) throw new Error('Unsupported Playwright Fetch listeners; download capture not installed');
  const paused: PausedHandler = event => {
    if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) { original[0]!(event); return; }
    void captureResponse(session, event, directory).catch(failed);
  };
  // Preserve request-stage routing/auth handlers; do not let them consume our response-stage pauses.
  session.off('Fetch.requestPaused', original[0]!); session.on('Fetch.requestPaused', paused);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    session.off('Fetch.requestPaused', paused); session.on('Fetch.requestPaused', original[0]!);
    void session.send('Fetch.disable').catch(() => {});
  };
  page.on('close', close);
  // Fetch interception is per attached tab; never detach its owner session or change global download settings.
  try { await session.send('Fetch.enable', { patterns: ['Document', 'Other'].map(resourceType => ({ urlPattern: '*', resourceType, requestStage: 'Response' })) }); }
  catch (error) { close(); throw error; }
}

export async function captureResponse(session: DownloadSession, event: PausedResponse, directory: string): Promise<void> {
  const header = (name: string) => event.responseHeaders?.find(entry => entry.name.toLowerCase() === name)?.value ?? '';
  const disposition = header('content-disposition');
  if (!/^https?:\/\//.test(event.request.url) || !['Document', 'Other'].includes(event.resourceType) || !/^attachment(?:;|$)/i.test(disposition.trim()) || !event.responseStatusCode || event.responseStatusCode < 200 || event.responseStatusCode >= 300 || event.responseStatusCode === 206) {
    await session.send(event.responseStatusCode ? 'Fetch.continueResponse' : 'Fetch.continueRequest', { requestId: event.requestId }); return;
  }
  const id = randomUUID(), prefix = join(directory, `.pikobot-download-${id}`);
  if (readdirSync(directory).filter(file => controlPattern.test(file)).length >= 16) {
    atomicWrite(join(directory, '.pikobot-download-overflow.error'), JSON.stringify('queue-full'));
    await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }); return;
  }
  let name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (name) { try { name = decodeURIComponent(name); } catch { name = undefined; } }
  name ??= /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition)?.slice(1).find(Boolean)?.trim();
  name = safeName(name || 'download.bin');
  const extension = extname(name).slice(1).toLowerCase(), file = `download-${id}.${/^[a-z0-9]{1,12}$/.test(extension) ? extension : 'bin'}`;
  const mime = header('content-type').split(';')[0]!.trim().toLowerCase();
  const metadata: CapturedDownload = { file, name, mimeType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) && mime.length <= 100 ? mime : 'application/octet-stream' };
  writeFileSync(`${prefix}.pending`, '', { mode: 0o600, flag: 'wx' });
  let handle: string | undefined, reason = 'transfer-failed';
  const abort = new AbortController();
  const closeStream = () => { if (handle) { const current = handle; handle = undefined; void session.send('IO.close', { handle: current }).catch(() => {}); } };
  let timeout!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { abort.abort(); reject(new Error('Download transfer timeout')); }, 30_000); timeout.unref(); });
  try {
    const work = async () => { try {
      const declared = header('content-length');
      if (/^\d+$/.test(declared) && Number(declared) > BRIDGE_FILE_BYTES) { reason = 'size-limit'; throw new Error('Download too large'); }
      const stream = await session.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
      if (typeof stream.stream !== 'string') throw new Error('Invalid browser download stream');
      handle = stream.stream;
      const chunks: Buffer[] = []; let length = 0;
      for (;;) {
        abort.signal.throwIfAborted();
        const chunk = validate<Static<typeof ChunkSchema>>(ChunkSchema, await session.send('IO.read', { handle, size: chunkBytes }));
        if (chunk.base64Encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) throw new Error('Invalid download bytes');
        const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
        length += bytes.length;
        if (bytes.length > chunkBytes || length > BRIDGE_FILE_BYTES) { reason = 'size-limit'; throw new Error('Download too large'); }
        chunks.push(bytes);
        if (chunk.eof) break;
        if (!bytes.length) throw new Error('Download stream made no progress');
      }
      abort.signal.throwIfAborted();
      const bytes = Buffer.concat(chunks);
      const responseHeaders = (event.responseHeaders ?? []).filter(entry => !['content-length', 'content-encoding', 'transfer-encoding'].includes(entry.name.toLowerCase()));
      responseHeaders.push({ name: 'Content-Length', value: String(bytes.length) });
      await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: event.responseStatusCode, responseHeaders, body: bytes.toString('base64') });
      abort.signal.throwIfAborted();
      atomicWrite(join(directory, file), bytes);
      atomicWrite(`${prefix}.json`, JSON.stringify(metadata));
    } finally { closeStream(); } };
    await Promise.race([work(), deadline]);
  } catch {
    abort.abort();
    void session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }).catch(() => {});
    if (existsSync(join(directory, file))) unlinkSync(join(directory, file));
    atomicWrite(`${prefix}.error`, JSON.stringify(reason));
  } finally {
    clearTimeout(timeout);
    closeStream();
    if (existsSync(`${prefix}.pending`)) unlinkSync(`${prefix}.pending`);
  }
}

export function collectedDownloads(directory: string): { files: (CapturedDownload & { control: string })[]; pending: number; errors: string[] } {
  const files: (CapturedDownload & { control: string })[] = [], errors: string[] = []; let pending = 0;
  const controls = new Set(readdirSync(directory));
  for (const control of controls) {
    if (control === '.pikobot-download-overflow.error' || control === '.pikobot-download-initialization.error') { errors.push(validate<string>(ErrorSchema, JSON.parse(readRegular(join(directory, control), 1024).toString()))); unlinkSync(join(directory, control)); continue; }
    const match = controlPattern.exec(control); if (!match) continue;
    if (match[2] === 'pending') { if (!controls.has(`.pikobot-download-${match[1]}.json`) && !controls.has(`.pikobot-download-${match[1]}.error`)) pending++; continue; }
    if (match[2] === 'error') { errors.push(validate<string>(ErrorSchema, JSON.parse(readRegular(join(directory, control), 1024).toString()))); unlinkSync(join(directory, control)); continue; }
    const metadata = validate<CapturedDownload>(CapturedDownloadSchema, JSON.parse(readRegular(join(directory, control), 4096).toString()));
    if (!metadata.file.startsWith(`download-${match[1]}.`)) throw new Error('Browser download identity mismatch');
    files.push({ ...metadata, control });
  }
  return { files, pending, errors };
}
