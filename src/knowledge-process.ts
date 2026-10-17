import { fork, execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { privateDirectory } from './config.js';

export const QMD_CONFIGURATION={version:'2.8.3',models:{embed:'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf',rerank:'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',generate:'hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf'},candidateLimit:20,cpu:true};
export class KnowledgeProcess {
  private child?: ChildProcess;
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private peakRssBytes=0;
  metrics(){return {kind:this.kind,pid:this.child?.pid,sampledPeakRssBytes:this.peakRssBytes,heapLimitMiB:512,rssLimitMiB:this.kind==='qmd'?8192:768};}
  constructor(readonly root: string, readonly kind: 'convert' | 'qmd' | 'web') {}
  request<T>(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const task = this.tail.then(() => this.execute<T>(op,args,signal));
    this.tail = task.catch(() => {}); return task;
  }
  private async execute<T>(op: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) throw new Error('Knowledge processing cancelled');
    if (!this.child) {
      const home = privateDirectory(join(this.root,'knowledge','worker-home'));
      this.child = fork(new URL('../dist/knowledge-worker.js', import.meta.url), [this.kind,this.root], {
        env: { HOME: home, XDG_CACHE_HOME: home, PATH: '/usr/bin:/bin:/opt/homebrew/bin', QMD_FORCE_CPU: '1', GGML_METAL_NO_RESIDENCY: '1' },
        execArgv: ['--max-old-space-size=512'], serialization: 'advanced', stdio: ['ignore','ignore','ignore','ipc']
      });
    }
    const child = this.child, requestId = ++this.sequence;
    return new Promise<T>((resolve,reject) => {
      let settled = false;
      const finish = (error?: Error, result?: T) => { if (settled) return; settled=true; clearTimeout(timeout); clearInterval(monitor); signal?.removeEventListener('abort',cancel); child.off('message',message); child.off('exit',exit); child.off('error',failure); error ? reject(error) : resolve(result!); };
      let stoppedError:Error|undefined;
      const stop = (error: Error) => { stoppedError??=error;child.kill('SIGKILL'); };
      const cancel = () => stop(new Error('Knowledge processing cancelled; subprocess terminated'));
      const timeout = setTimeout(() => stop(new Error('Knowledge subprocess timeout; terminated')), this.kind === 'qmd' ? 600_000 : this.kind === 'web' ? 15_000 : 60_000);
      // Native parsers/models allocate outside V8. Bound RSS as well as heap and wall time.
      const monitor = setInterval(() => { if (child.pid) execFile('/bin/ps',['-o','rss=','-p',String(child.pid)],{timeout:2000},(error,stdout) => { if(!settled&&error)stop(new Error('Knowledge RSS monitor unavailable; subprocess terminated'));if(!settled)this.peakRssBytes=Math.max(this.peakRssBytes,Number(stdout.trim())*1024);if (!settled && Number(stdout.trim()) > (this.kind==='qmd'?8192:768)*1024) stop(new Error('Knowledge subprocess RSS limit exceeded; terminated')); }); },1000);
      const message = (value: unknown) => { const response=value as {id:number;error?:string;result:T}; if(response.id===requestId)finish(response.error?new Error(response.error):undefined,response.result); };
      const exit = (code:number|null,signal:NodeJS.Signals|null) => { if(this.child===child)this.child=undefined;finish(stoppedError??new Error(`Knowledge subprocess stopped (${signal??code}); inspect native dependency setup`)); };
      const failure = () => { if(this.child===child)this.child=undefined;finish(new Error('Knowledge subprocess unavailable')); };
      child.on('message',message);child.once('exit',exit);child.once('error',failure);signal?.addEventListener('abort',cancel,{once:true});
      child.send({id:requestId,op,args},error=>{if(error)failure();});
    });
  }
  async close(): Promise<void> {
    this.closed=true; const child=this.child;this.child=undefined;
    if(child && child.exitCode===null && child.signalCode===null)await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGKILL');});
    await this.tail;
  }
}
