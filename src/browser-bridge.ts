import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { Client, type Tool, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { atomicWrite, existingPrivateDirectory, privateDirectory, readPrivate, tokenMatches } from './config.js';
import { Credentials } from './credentials.js';
import { validate } from './contracts.js';
import { readRegular } from './skill-package.js';
import { hash, json } from './store.js';
import { BROWSER_TOOLS, bridgeUrl, browserArtifactMentioned } from './mcp-browser.js';
import { BRIDGE_FILE_BYTES, BRIDGE_RESULT_BYTES, BridgeConfigSchema, type BridgeArtifact, type BridgeConfig, type BridgePairing } from './browser-bridge-contracts.js';

function checkedConfig(raw: unknown): BridgeConfig {
  const config = validate<BridgeConfig>(BridgeConfigSchema, raw);
  if (!isAbsolute(config.entrypoint) || /[\x00-\x1f\x7f]/.test(config.entrypoint) || !lstatSync(config.entrypoint).isFile()) throw new Error('Select an absolute path to an already installed, trusted Playwright MCP cli.js');
  return config;
}
export async function initializeBrowserBridge(root: string, entrypoint: string, profile: string, port: number, extensionToken: string): Promise<BridgeConfig> {
  const config = checkedConfig({ version: 1, id: randomUUID(), entrypoint, profile, port });
  if (!/^[\x21-\x7e]{16,1024}$/.test(extensionToken)) throw new Error('Invalid extension token; use its separate masked/stdin setup flow');
  privateDirectory(root);
  if (readdirSync(root).length) throw new Error('Choose an empty private bridge directory, never a Pico owner or browser profile directory');
  closeSync(openSync(join(root, '.initialized'), 'wx', 0o600));
  const credentials = new Credentials(root);
  await credentials.setSecret('browser.extensionToken', extensionToken);
  await credentials.setSecret('browser.bridgeToken', randomBytes(32).toString('base64url'));
  await credentials.setSecret('browser.binding', hash(json(config)));
  atomicWrite(join(root, 'bridge.json'), json(config));
  return config;
}
export function browserBridgeConfig(root: string): BridgeConfig {
  existingPrivateDirectory(root);
  return checkedConfig(JSON.parse(readPrivate(join(root, 'bridge.json'))));
}
async function bridgeSecrets(root: string, config: BridgeConfig) {
  const credentials = new Credentials(root), bearer = await credentials.secret('browser.bridgeToken'), extensionToken = await credentials.secret('browser.extensionToken');
  if (!bearer || !/^[A-Za-z0-9_-]{43}$/.test(bearer) || !extensionToken || !/^[\x21-\x7e]{16,1024}$/.test(extensionToken) || await credentials.secret('browser.binding') !== hash(json(config))) throw new Error('Bridge identity, profile, entrypoint or credentials changed; create a new explicit pairing, never reuse old authority');
  return { bearer, extensionToken };
}
export async function browserBridgePairing(root: string, url: string): Promise<BridgePairing> {
  const config = browserBridgeConfig(root), { bearer } = await bridgeSecrets(root, config);
  return { version: 1, bridgeId: config.id, url: bridgeUrl(url), token: bearer };
}

/** A browser-only MCP endpoint. It never exposes Pico owner RPC or launches a replacement backend. */
export async function serveBrowserBridge(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const config = browserBridgeConfig(root), { bearer, extensionToken } = await bridgeSecrets(root, config);
  const temporary = await mkdtemp('/tmp/pico-browser-bridge-'), output = privateDirectory(join(temporary, 'artifacts'));
  const controller = new AbortController(), client = new Client({ name: 'pico-browser-bridge', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
  const transport = new StdioClientTransport({ command: process.execPath, args: [config.entrypoint, '--extension', '--browser', 'chrome', '--profile-dir-name', config.profile, '--output-dir', output, '--file-paths', 'absolute', '--caps', 'pdf', '--no-webmcp', '--codegen', 'none'], cwd: output,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), LANG: 'en_US.UTF-8', TMPDIR: temporary, ...Object.fromEntries(['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])), PLAYWRIGHT_MCP_EXTENSION_TOKEN: extensionToken }, stderr: 'pipe', maxBufferSize: BRIDGE_RESULT_BYTES });
  transport.stderr?.on('data', () => {});
  let connected = false, closing = false, activeHttp = 0, queued = 0, tail: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, { metadata: BridgeArtifact; bytes: Buffer }>(); let cachedBytes = 0;
  const redact = (value: string) => {
    for (const secret of [bearer, extensionToken].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]').replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]');
    return value;
  };
  const capture = (value: CallToolResult): CallToolResult => {
    const serialized = json(value);
    if (Buffer.byteLength(serialized) > BRIDGE_RESULT_BYTES) throw new Error('Browser result too large');
    const result = JSON.parse(redact(serialized)) as CallToolResult;
    // The backend cannot mint handles or turn its own paths into arbitrary resource reads.
    delete result.browserArtifacts;
    if (result.isError) return result;
    const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const files = readdirSync(output);
    if (files.length > 512) throw new Error('Too many browser outputs');
    const artifacts: BridgeArtifact[] = []; let receiptBytes = 0;
    for (const name of files) {
      if (!browserArtifactMentioned(text, name)) continue;
      const bytes = readRegular(join(output, name), BRIDGE_FILE_BYTES);
      if ([bearer, extensionToken].some(secret => bytes.includes(Buffer.from(secret)))) throw new Error('Browser output contains a bridge credential');
      receiptBytes += bytes.length;
      if (artifacts.length >= 16 || receiptBytes > 50_000_000) throw new Error('Too many browser artifacts in one result');
      while (cache.size >= 64 || cachedBytes + bytes.length > 50_000_000) { const key = cache.keys().next().value!; cachedBytes -= cache.get(key)!.bytes.length; cache.delete(key); }
      const metadata: BridgeArtifact = { name, uri: `pico-browser-artifact:${config.id}:${randomBytes(32).toString('hex')}`, mimeType: 'application/octet-stream', bytes: bytes.length, hash: hash(bytes) };
      cache.set(metadata.uri, { metadata, bytes }); cachedBytes += bytes.length; artifacts.push(metadata);
      unlinkSync(join(output, name));
    }
    return { ...result, browserArtifacts: artifacts };
  };
  client.onerror = () => {};
  client.onclose = () => { connected = false; };
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  const http = createServer({ maxHeaderSize: 16_000 }, async (request, response) => {
    response.once('error', () => response.destroy());
    const reply = (status: number, text: string) => { if (response.destroyed || response.writableEnded) return; response.writeHead(status, { 'cache-control': 'no-store' }); response.end(text); };
    if (request.url !== '/mcp') { reply(404, 'Not found'); return; }
    let hostname = ''; try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch {}
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(hostname) || request.headers.origin !== undefined) { reply(403, 'Forbidden'); return; }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token || !tokenMatches(token, bearer)) { reply(401, 'Unauthorized'); return; }
    if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) { reply(405, 'Method not allowed'); return; }
    if (closing || activeHttp >= 8) { reply(503, 'Bridge busy or stopping'); return; }
    activeHttp++;
    const abort = new AbortController();
    request.once('aborted', () => abort.abort()); response.once('close', () => { if (!response.writableEnded) abort.abort(); });
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 1_000_000) { request.resume(); reply(413, 'Request too large'); return; } chunks.push(Buffer.from(chunk)); }
      const headers = new Headers(request.headers as Record<string, string>);
      for (const name of ['authorization', 'cookie', 'host', 'origin']) headers.delete(name);
      const result = await handler!.fetch(new Request('http://127.0.0.1/mcp', { method: request.method, headers, signal: abort.signal, ...(length ? { body: Buffer.concat(chunks) } : {}) }));
      response.writeHead(result.status, { ...Object.fromEntries(result.headers), 'cache-control': 'no-store' });
      if (result.body) await pipeResponse(result.body, response); else response.end();
    } catch { if (!response.headersSent) reply(400, 'Browser bridge request failed; inspect receipts before retrying effects'); else response.destroy(); }
    finally { activeHttp--; }
  });
  http.maxConnections = 16; http.headersTimeout = 10_000; http.requestTimeout = 30_000; http.keepAliveTimeout = 1000;
  const close = async () => {
    if (closing) return; closing = true; controller.abort(new Error('Browser bridge stopping; accepted effects are not undone'));
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    try { await handler?.close(); }
    finally { await client.close().catch(() => {}); cache.clear(); await rm(temporary, { recursive: true, force: true }); }
  };
  try {
    await client.connect(transport, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), timeout: 30_000 }); connected = true;
    const tools: Tool[] = [], seen = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 16; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000, signal: controller.signal });
      for (const tool of result.tools) {
        if (seen.has(tool.name)) throw new Error('Duplicate browser tool'); seen.add(tool.name);
        if (BROWSER_TOOLS.includes(tool.name)) tools.push(tool);
      }
      if (Buffer.byteLength(json(tools)) > 256_000 || result.nextCursor && page === 15) throw new Error('Browser catalog too large');
      if (!result.nextCursor) break; cursor = result.nextCursor;
    }
    if (!connected || !tools.length || redact(json(tools)) !== json(tools)) throw new Error('Browser tool discovery failed');
    const validator = new AjvJsonSchemaValidator();
    handler = createMcpHandler(() => {
      const server = new Server({ name: `pico-browser-bridge:${config.id}`, version: '1' }, { capabilities: { tools: {}, resources: {} } });
      server.setRequestHandler('tools/list', async () => { if (!connected) throw new Error('Browser backend disconnected; restart deliberately, never replay uncertain calls'); return { tools }; });
      server.setRequestHandler('resources/list', async () => ({ resources: [] }));
      server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }));
      server.setRequestHandler('resources/read', async request => {
        const item = cache.get(request.params.uri);
        if (!item) throw new Error('Browser artifact missing or expired; never repeat the browser action to recover it');
        return { contents: [{ uri: item.metadata.uri, mimeType: item.metadata.mimeType, blob: item.bytes.toString('base64') }] };
      });
      server.setRequestHandler('tools/call', async (request, context) => {
        const definition = tools.find(tool => tool.name === request.params.name);
        if (!definition || !validator.getValidator(definition.inputSchema as JsonSchemaType)(request.params.arguments ?? {}).valid || request.params.task) throw new Error('Browser tool or arguments not allowed');
        if (queued >= 20 || !connected) throw new Error('Browser backend busy or disconnected');
        const signal = AbortSignal.any([controller.signal, context.mcpReq.signal, AbortSignal.timeout(90_000)]); queued++;
        const work = tail.catch(() => {}).then(async () => {
          signal.throwIfAborted(); if (!connected) throw new Error('Browser backend disconnected');
          if (readdirSync(output).length > 512) throw new Error('Browser staging directory full; stop and inspect, do not replay prior effects');
          try { return capture(await client.callTool({ name: definition.name, arguments: request.params.arguments ?? {} }, { signal, timeout: 90_000, toolDefinition: definition })); }
          catch { return { content: [{ type: 'text' as const, text: 'Browser call or artifact capture failed; effects may have occurred. Do not automatically replay.' }], isError: true }; }
        });
        tail = work;
        try { return await work; } finally { queued--; }
      });
      return server;
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.port, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${config.port}/mcp`, close };
  } catch { await close(); throw new Error('Browser bridge startup failed; inspect the selected installed entrypoint, local port and private configuration. No browser call was replayed.'); }
}
async function pipeResponse(body: ReadableStream<Uint8Array>, response: ServerResponse): Promise<void> {
  const stream = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
  await new Promise<void>((resolve, reject) => { stream.once('error', reject); response.once('error', reject); response.once('close', () => { stream.destroy(); resolve(); }); response.once('finish', resolve); stream.pipe(response); });
}
