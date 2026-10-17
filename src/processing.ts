import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateDirectory } from './config.js';
import type { EmbeddingProvider } from './contracts.js';

export const E5_MODEL = 'Xenova/multilingual-e5-small';
export const E5_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export class Processor {
  private worker?: Worker;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(readonly root: string, readonly model = E5_MODEL, readonly revision = E5_REVISION) {}
  async request<T>(kind: 'embedding' | 'pdf', input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Processing cancelled');
    if (!this.worker) {
      this.worker = new Worker(new URL(import.meta.url.endsWith('.ts')?'./processing-worker.ts':'./processing-worker.js',import.meta.url), { workerData: { cacheDir: privateDirectory(join(this.root,'model-cache')), model:this.model, revision:this.revision }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 }, stdout:true, stderr:true });
      // No private content or library diagnostics go to application logs.
      this.worker.stdout?.resume(); this.worker.stderr?.resume();
      this.worker.on('message',(message: {id:string;result:unknown;error?:string}) => { const pending=this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); });
      const worker=this.worker;
      const failure = () => { if(this.worker!==worker)return;for (const pending of this.pending.values()) pending.reject(new Error('Processing worker stopped')); this.pending.clear(); this.worker = undefined; };
      this.worker.on('error',failure); this.worker.on('exit',failure);
    }
    return new Promise<T>((resolve,reject) => {
      const requestId=randomUUID();
      const timeout=setTimeout(()=>{ this.pending.delete(requestId); finish(()=>reject(new Error('Processing timeout; model download/indexing may be pending'))); void this.close(); },300_000);
      // The worker queue cannot cancel individual native tasks; discard its queued content too.
      const cancel=()=>{ this.pending.delete(requestId); finish(()=>reject(new Error('Processing cancelled'))); void this.close(); };
      signal?.addEventListener('abort',cancel,{once:true});
      const finish=(fn:()=>void)=>{ clearTimeout(timeout); signal?.removeEventListener('abort',cancel); fn(); };
      this.pending.set(requestId,{resolve:value=>finish(()=>resolve(value as T)),reject:error=>finish(()=>reject(error))});
      try{this.worker!.postMessage({id:requestId,kind,...input});}catch(error){this.pending.delete(requestId);finish(()=>reject(error));}
    });
  }
  async close(): Promise<void> { const worker=this.worker;this.worker=undefined;for(const pending of this.pending.values())pending.reject(new Error('Processing worker closed'));this.pending.clear();await worker?.terminate(); }
}
export class LocalEmbeddings implements EmbeddingProvider {
  readonly model = E5_MODEL; readonly dimensions = 384; readonly version = E5_REVISION;
  constructor(readonly processor: Processor) {}
  embed(texts: string[], signal?: AbortSignal, purpose: 'query' | 'passage' = 'passage'): Promise<number[][]> { return texts.length ? this.processor.request('embedding',{texts,purpose},signal) : Promise.resolve([]); }
}
