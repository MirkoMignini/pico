import { afterEach, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { mcpFetch } from '../src/mcp-network.js';

vi.mock('node:dns/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:dns/promises')>(), lookup: vi.fn() }));
afterEach(() => vi.mocked(lookup).mockReset());
const signal = () => new AbortController().signal;

it('refuses every mixed public/private DNS answer before opening a network connection', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] as any);
  const server = { id: 'fixture', enabled: true, transport: 'http' as const, url: 'https://mcp.example/mcp' };
  await expect(mcpFetch(server, signal())(server.url)).rejects.toThrow('private/reserved DNS');
  expect(lookup).toHaveBeenCalledOnce();
});

it('does not expand private-network permission to other resource origins or OAuth hosts', async () => {
  const server = { id: 'fixture', enabled: true, transport: 'http' as const, url: 'http://127.0.0.1:3000/mcp', allowPrivateNetwork: true };
  await expect(mcpFetch(server, signal())('http://127.0.0.1:3001/messages')).rejects.toThrow('cross-origin');
  await expect(mcpFetch(server, signal(), true)('http://127.0.0.1:3001/token')).rejects.toThrow('HTTPS');
  vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
  await expect(mcpFetch(server, signal(), true)('https://issuer.example/token')).rejects.toThrow('private/reserved DNS');
});
