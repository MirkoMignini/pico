import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '../src/client.js';
import { setup, waitFor } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(handler: RequestListener) {
  const s = setup(), server: Server = createServer(handler), client = new Client(s.root);
  await new Promise<void>(resolve => server.listen(join(s.root, 'daemon.sock'), resolve));
  cleanup.push(async () => { client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  return { server, client };
}

it('bounds a stalled SSE handshake and reports one disconnect without retrying the request', async () => {
  const { server, client } = await fixture(() => {}), observed = once(server, 'request');
  let disconnected = 0, connected = 0;
  vi.useFakeTimers();
  const lost = new Promise<void>(resolve => { client.subscribe(() => {}, () => { disconnected++; resolve(); }, () => { connected++; }); });
  await observed;
  await vi.advanceTimersByTimeAsync(5001); await lost;
  expect(disconnected, 'A silent handshake must not leave the client waiting indefinitely').toBe(1);
  expect(connected).toBe(0);
  await vi.advanceTimersByTimeAsync(5000); expect(disconnected).toBe(1);
});

it('does not apply the handshake deadline to an established quiet event stream and closes it intentionally without reconnecting', async () => {
  let response: ServerResponse | undefined;
  const { client } = await fixture((_request, output) => { response = output; output.writeHead(200, { 'Content-Type': 'text/event-stream' }); output.write(': connected\n\n'); });
  let disconnected = 0;
  vi.useFakeTimers();
  const connected = new Promise<void>(resolve => client.subscribe(() => {}, () => { disconnected++; }, resolve));
  await connected;
  await vi.advanceTimersByTimeAsync(60_000); expect(disconnected).toBe(0); expect(response?.destroyed).toBe(false);
  client.close();
  vi.useRealTimers(); await new Promise(resolve => setTimeout(resolve, 20));
  expect(disconnected, 'Closing the client is not a request to reconnect').toBe(0);
});

it('rejects an unauthenticated event response once without reporting a successful connection', async () => {
  const { client } = await fixture((_request, response) => response.writeHead(401).end('Unauthorized'));
  let losses = 0, connections = 0;
  await new Promise<void>(resolve => client.subscribe(() => {}, () => { losses++; resolve(); }, () => { connections++; }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(losses).toBe(1); expect(connections).toBe(0);
});

it('reports a remotely truncated SSE stream once and replaces an old subscription without leaking it', async () => {
  const responses: ServerResponse[] = [];
  const { client } = await fixture((_request, response) => { responses.push(response); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': connected\n\n'); });
  let firstLosses = 0, secondLosses = 0;
  await new Promise<void>(resolve => client.subscribe(() => {}, () => { firstLosses++; }, resolve));
  const old = responses[0]!;
  await new Promise<void>(resolve => client.subscribe(() => {}, () => { secondLosses++; }, resolve));
  await waitFor(() => old.destroyed);
  expect(firstLosses).toBe(0);
  responses[1]!.destroy(); await waitFor(() => secondLosses > 0); await new Promise(resolve => setTimeout(resolve, 20));
  expect(secondLosses).toBe(1);
});
