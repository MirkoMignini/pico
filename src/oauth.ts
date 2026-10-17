import { randomUUID } from 'node:crypto';
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai';
import { ModelAccess } from './models.js';

export interface LoginStatus {
  id?: string; provider?: string;
  state: 'idle' | 'pending' | 'completed' | 'cancelled' | 'expired' | 'failed';
  events: { seq: number; event: AuthEvent }[];
  prompt?: AuthPrompt & { id: string };
  error?: string;
}

/** Only relays Pi's provider-owned interactions over authenticated IPC; no OAuth protocol lives here. */
export class ProviderLogin {
  status: LoginStatus = { state: 'idle', events: [] };
  private controller?: AbortController;
  private done?: Promise<void>;
  private answer?: { id: string; resolve: (value: string) => void; reject: (error: Error) => void };
  private closed = false;
  constructor(readonly models: ModelAccess) {}
  start(provider: string, type: AuthType, account = 'default'): LoginStatus {
    if (this.closed) throw new Error('Authentication is shutting down');
    if (this.status.state === 'pending') throw new Error('An authorization is already pending');
    if (!this.models.providers().some(item => item.id === provider && item.methods.some(method => method.type === type))) throw new Error('Unsupported provider authentication method');
    if (!/^[a-z0-9-]{1,40}$/.test(account) || provider !== 'openai' && account !== 'default') throw new Error('Invalid account label');
    const controller = new AbortController(); this.controller = controller;
    const status: LoginStatus = { id: randomUUID(), provider, state: 'pending', events: [] }; this.status = status;
    let expired = false;
    const timeout = setTimeout(() => { expired = true; controller.abort(); }, 900_000); timeout.unref();
    this.done = this.models.login(provider, type, {
      signal: controller.signal,
      notify: event => {
        if (controller.signal.aborted) return;
        if (status.events.length >= 200) { controller.abort(); return; }
        status.events.push({ seq: status.events.length + 1, event });
      },
      prompt: prompt => new Promise<string>((resolve, reject) => {
        const signal = prompt.signal ? AbortSignal.any([prompt.signal, controller.signal]) : controller.signal;
        if (signal.aborted) { reject(new Error('Login cancelled')); return; }
        const { signal: _signal, ...value } = prompt;
        const id = randomUUID(); status.prompt = { ...value, id };
        const clear = () => { signal.removeEventListener('abort', abort); if (this.answer?.id === id) this.answer = undefined; if (status.prompt?.id === id) delete status.prompt; };
        const abort = () => { clear(); reject(new Error('Login cancelled')); };
        this.answer = { id, resolve: value => { clear(); resolve(value); }, reject: error => { clear(); reject(error); } };
        signal.addEventListener('abort', abort, { once: true });
      })
    }, account).then(() => { status.state = expired ? 'expired' : controller.signal.aborted ? 'cancelled' : 'completed'; }, () => {
      status.state = expired ? 'expired' : controller.signal.aborted ? 'cancelled' : 'failed';
      if (status.state === 'failed') status.error = 'Provider login failed. Retry /login and check provider setup (OpenAI browser callbacks use port 1455). No billing fallback was used.';
    }).finally(() => { clearTimeout(timeout); if (this.status === status) this.answer?.reject(new Error('Login ended')); delete status.prompt; });
    return status;
  }
  read(id?: string): LoginStatus {
    if (id !== undefined && id !== this.status.id) throw new Error('Login not found');
    return this.status;
  }
  respond(id: string, promptId: string, value: string): void {
    const status = this.read(id), prompt = status.prompt;
    if (status.state !== 'pending' || prompt?.id !== promptId || this.answer?.id !== promptId) throw new Error('Login prompt is no longer active');
    if (value.length > 8192 || prompt.type === 'secret' && !value.trim() || prompt.type === 'select' && !prompt.options.some(option => option.id === value)) throw new Error('Invalid login response');
    this.answer.resolve(value);
  }
  async cancel(id: string): Promise<void> {
    this.read(id); this.controller?.abort(); await this.done;
  }
  async close(): Promise<void> {
    this.closed = true; this.controller?.abort(); await this.done;
  }
}
