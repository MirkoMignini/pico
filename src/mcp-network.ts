import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import type { FetchLike } from '@modelcontextprotocol/client';
import { publicAddress } from './web-network.js';
import { mcpUrl, type McpServer } from './mcp-contracts.js';

/** MCP endpoints are operator-selected, not an escape hatch in the public web fetcher. */
export function mcpFetch(server: Exclude<McpServer, { transport: 'stdio' }>, parent: AbortSignal, oauth = false): FetchLike {
  const origin = mcpUrl(server.url).origin;
  return async (input, init) => {
    const request = new Request(input, init), url = mcpUrl(request.url);
    const ownOrigin = url.origin === origin, privateAllowed = ownOrigin && server.allowPrivateNetwork === true;
    if (!ownOrigin && !oauth) throw new Error('MCP cross-origin endpoint refused');
    if (url.protocol !== 'https:' && !privateAllowed) throw new Error('MCP requires HTTPS; private HTTP needs explicit allowPrivateNetwork');
    const signal = AbortSignal.any([parent, request.signal]);
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      const cancel = () => reject(new Error('MCP DNS lookup cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      (isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, order: 'verbatim' }))
        .then(resolve, () => reject(new Error('MCP DNS lookup failed'))).finally(() => signal.removeEventListener('abort', cancel));
      if (signal.aborted) cancel();
    });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(entry => isIP(entry.address) !== entry.family || !privateAllowed && !publicAddress(entry.address))) throw new Error('MCP private/reserved DNS target denied');
    const selected = addresses.find(entry => entry.family === 4) ?? addresses[0]!;
    const bytes = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const limit = server.maxBytes ?? 8_000_000;
    if (bytes && bytes.length > limit) throw new Error('MCP request exceeds byte limit');
    const headers = Object.fromEntries(request.headers);
    // No cookie jar, redirects, proxy/environment credentials, or decompression bombs.
    headers['accept-encoding'] = 'identity'; delete headers.host; delete headers.connection; delete headers['content-length'];
    if (bytes) headers['content-length'] = String(bytes.length);
    return new Promise<Response>((resolve, reject) => {
      const connection = (url.protocol === 'https:' ? https : http).request(url, {
        method: request.method, headers, agent: false, family: selected.family, signal,
        lookup: (_name, _options, callback) => callback(null, selected.address, selected.family)
      }, incoming => {
        const status = incoming.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) { incoming.destroy(); reject(new Error('MCP redirect refused; configure the exact endpoint')); return; }
        if (status < 200 || status > 599 || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') { incoming.destroy(); reject(new Error('Unsupported MCP HTTP response')); return; }
        const length = incoming.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > limit)) { incoming.destroy(); reject(new Error('MCP response exceeds byte limit')); return; }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
        let read = 0;
        const bounded = new Transform({ transform(chunk: Buffer, _encoding, done) { read += chunk.length; done(read > limit ? new Error('MCP response exceeds byte limit') : null, chunk); } });
        incoming.once('error', error => bounded.destroy(error));
        bounded.once('close', () => incoming.destroy());
        incoming.pipe(bounded);
        const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(bounded) as ReadableStream<Uint8Array>;
        if (!body) incoming.resume();
        const response = new Response(body, { status, headers: responseHeaders });
        Object.defineProperty(response, 'url', { value: url.href });
        resolve(response);
      });
      connection.once('error', () => reject(new Error('MCP network/TLS request failed')));
      connection.setTimeout(server.timeoutMs ?? 60_000, () => connection.destroy(new Error('MCP HTTP idle timeout')));
      connection.end(bytes);
    });
  };
}
