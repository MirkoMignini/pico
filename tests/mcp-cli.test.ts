import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/daemon.js';
import { Runtime } from '../src/runtime.js';
import { atomicWrite } from '../src/config.js';
import { setup } from './helpers.js';

it('configures and calls MCP through the compiled CLI/Unix IPC, keeping credential JSON in private stdin', async () => {
  const s = setup('mcp-cli'); atomicWrite(join(s.root, 'config.json'), JSON.stringify(s.config));
  const service = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models) });
  const cli = (args: string[], input = '') => new Promise<any>((resolve, reject) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--instance', s.root, 'mcp', ...args], { timeout: 10_000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout)));
    child.stdin!.end(input);
  });
  try {
    const settings = { servers: [{ id: 'fixture', enabled: true, transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))], readOnlyTools: ['read.echo', 'inspect'] }] };
    expect(await cli(['configure', '-'], JSON.stringify(settings))).toEqual({ saved: true });
    expect(await cli(['secret', 'fixture'], '{"env":{"OPERATOR_TOKEN":"synthetic-cli-token"}}')).toEqual({ saved: true });
    expect((await cli(['connect', 'fixture'])).servers[0].state).toBe('connected');
    expect(await cli(['call', 'fixture', 'read.echo'], '{"text":"compiled CLI"}')).toMatchObject({ structuredContent: { text: 'compiled CLI' } });
    expect(JSON.stringify(await cli(['call', 'fixture', 'inspect'], '{"text":""}'))).not.toContain('synthetic-cli-token');
    await expect(cli(['approve', 'not-an-action'])).rejects.toThrow('noninteractive approval');
    await expect(cli(['secret', 'fixture', 'never-echo-this-secret'])).rejects.toThrow('never pass credentials');
    expect((await cli(['status'])).servers[0].state).toBe('connected');
    expect(await cli(['browser', fileURLToPath(new URL('./fixtures/mcp-browser-server.mjs', import.meta.url))])).toMatchObject({ saved: true });
    expect((await cli(['status'])).servers.find((server: any) => server.id === 'browser')).toMatchObject({ state: 'not_connected', paused: false });
    await cli(['pause', 'browser']);
    expect((await cli(['status'])).servers.find((server: any) => server.id === 'browser').paused).toBe(true);
    await cli(['resume', 'browser']);
    await expect(cli(['import', 'browser'], '{"sourceId":"operation:missing","contentIndex":1}')).rejects.toThrow('retained');
    expect(s.faux.state.callCount).toBe(0);
  } finally { await service.close(); await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
}, 45_000);

it('requires explicit live-check authorization and keeps help inert', async () => {
  const execute = promisify(execFile), script = fileURLToPath(new URL('../scripts/check-mcp-live.mjs', import.meta.url));
  expect((await execute(process.execPath, [script, '--help'], { timeout: 5000 })).stdout).toContain('No model, owner credentials');
  await expect(execute(process.execPath, [script], { timeout: 5000 })).rejects.toThrow('--run required');
  await expect(execute(process.execPath, [script, '--run', '--instance', '/must-not-use-an-owner'], { timeout: 5000 })).rejects.toThrow('--run required');
});
