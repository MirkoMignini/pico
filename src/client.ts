import { request as httpRequest } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputEvent } from './contracts.js';

export class Client {
  private unsubscribe: (() => void) | undefined;
  readonly socket: string; readonly token: string;
  constructor(readonly root: string) { const settings = loadConfig(root); this.socket = settings.socket; this.token = settings.token; }
  rpc<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 330_000): Promise<T> {
    return new Promise((resolve,reject) => {
      const body = JSON.stringify({ op,args });
      const request = httpRequest({ socketPath: this.socket, path: '/rpc', method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('aborted',() => reject(new Error('Daemon response interrupted; inspect durable status before retrying consequential actions')));
        response.on('error',reject);
        response.on('data',chunk => { bytes += chunk.length; if (bytes > 30_000_000) { request.destroy(new Error('Response too large')); return; } chunks.push(chunk); });
        response.on('end',() => { try { const data = JSON.parse(Buffer.concat(chunks).toString()) as { ok: boolean; result: T; error: string }; data.ok ? resolve(data.result) : reject(new Error(data.error)); } catch (error) { reject(error); } });
      });
      const timer = setTimeout(() => request.destroy(new Error('Daemon operation timed out; inspect durable status before retrying consequential actions')), timeoutMs);
      request.once('close', () => clearTimeout(timer)); request.on('error',reject); request.end(body);
    });
  }
  async ensureDaemon(): Promise<void> {
    const check = async () => {
      const status = await this.rpc<{ extensionsExecution?: { mode: string } }>('status');
      if (status.extensionsExecution?.mode !== 'in-process') throw new Error('A legacy extension-worker daemon is already running. Ask its operator to upgrade/restart it; it will not be replaced automatically.');
    };
    try { await check(); return; } catch (error) { if (!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (existsSync(join(this.root, 'service.json'))) throw new Error('This instance has an installed service. Use pikobot --instance PATH service start; a detached replacement will not be spawned.');
    const daemon = spawn(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),'--instance',this.root,'serve'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'en_US.UTF-8' } });
    daemon.unref();
    for (let i = 0; i < 100; i++) { await sleep(100); try { await check(); return; } catch (error) { if (!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; } }
    throw new Error('Daemon startup failed. Run `pikobot --instance PATH serve` for its diagnostic; an existing authority is never replaced.');
  }
  subscribe(output: (event: OutputEvent) => void, disconnected: () => void, connected?:()=>void): () => void {
    this.unsubscribe?.();
    let closed = false, notified = false, buffer = '', timer: NodeJS.Timeout | undefined;const decoder=new StringDecoder('utf8');
    const lost = () => { clearTimeout(timer); if (!closed && !notified) { notified = true; disconnected(); } };
    const request = httpRequest({ socketPath: this.socket, path: '/events', method: 'GET', agent: false, headers: { Authorization: `Bearer ${this.token}` } }, response => {
      clearTimeout(timer);
      if (closed) { response.destroy(); return; }
      if (response.statusCode !== 200) { request.destroy(new Error('Event authentication failed')); return; }
      response.on('data',data => {
        buffer += decoder.write(data); let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary + 2); if (frame.startsWith('data: ')) { try { output(JSON.parse(frame.slice(6)) as OutputEvent); } catch {} } }
        if (buffer.length > 1_000_000) request.destroy();
      });
      response.on('end', lost); response.on('error', lost); response.on('close', lost);
      connected?.();
    });
    timer = setTimeout(() => request.destroy(new Error('Event connection timed out')), 5000);
    request.on('error', lost); request.end();
    const unsubscribe = () => { closed = true; clearTimeout(timer); request.destroy(); if (this.unsubscribe === unsubscribe) this.unsubscribe = undefined; };
    this.unsubscribe = unsubscribe;
    return unsubscribe;
  }
  close(): void { this.unsubscribe?.(); }
}
