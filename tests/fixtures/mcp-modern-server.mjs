import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function modernFixture() {
  const server = new McpServer({ name: 'pico-modern-synthetic', version: '1.0.0' });
  const schema = fromJsonSchema({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false });
  server.registerTool('read.echo', { description: 'Synthetic modern echo', inputSchema: schema, outputSchema: schema }, async input => ({ content: [{ type: 'text', text: input.text }], structuredContent: { text: input.text } }));
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const markerIndex = process.argv.indexOf('--marker');
  if (markerIndex >= 0) appendFileSync(process.argv[markerIndex + 1], 'started\n', { mode: 0o600 });
  serveStdio(() => modernFixture());
}
