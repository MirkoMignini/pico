import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, readPrivate } from './config.js';
import type { AuthOperationOptions, Credential, CredentialStore, CredentialInfo } from '@earendil-works/pi-ai';

interface SecretData { entries: Record<string, Credential>; secrets: Record<string, string>; activeOpenai?: string }
export class Credentials implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(root: string) { this.path = join(root, 'secrets.json'); }
  private load(): SecretData { return existsSync(this.path) ? JSON.parse(readPrivate(this.path)) as SecretData : { entries: {}, secrets: {} }; }
  private serialized<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.then(fn, fn); this.tail = next.catch(() => {}); return next; }
  async read(provider: string): Promise<Credential | undefined> {
    await this.tail;
    const data = this.load();
    return data.entries[provider === 'openai' ? data.activeOpenai ?? provider : provider];
  }
  async list(): Promise<CredentialInfo[]> { await this.tail; const data = this.load(); return Object.entries(data.entries).map(([providerId, credential]) => ({ providerId, type: credential.type })); }
  alias(provider: string, key: string): CredentialStore {
    const target = (id: string) => id === provider ? key : id;
    return { read: id => this.read(target(id)), list: () => this.list(),
      modify: (id, fn, options) => this.modify(target(id), fn, options), delete: (id, options) => this.delete(target(id), options) };
  }
  modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.serialized(async () => {
      options?.signal?.throwIfAborted();
      const data = this.load(), key = provider === 'openai' ? data.activeOpenai ?? provider : provider;
      const next = await fn(data.entries[key]);
      if (next !== undefined) { data.entries[key] = next; atomicWrite(this.path, JSON.stringify(data)); }
      return next ?? data.entries[key];
    });
  }
  delete(provider: string, options?: AuthOperationOptions): Promise<void> { return this.serialized(async () => { options?.signal?.throwIfAborted(); const data = this.load(); delete data.entries[provider === 'openai' ? data.activeOpenai ?? provider : provider]; atomicWrite(this.path, JSON.stringify(data)); }); }
  async secret(name: string): Promise<string | undefined> {
    await this.tail;const data=this.load();
    const api=['openai.embeddingKey','openai.mediaKey','openai.imageKey','openai.speechKey'].includes(name)?data.entries['openai-api']:undefined;
    return data.secrets[name]??(api?.type==='api_key'?api.key:undefined);
  }
  setSecret(name: string, value: string, signal?: AbortSignal): Promise<void> { return this.serialized(async () => { signal?.throwIfAborted(); const data = this.load(); data.secrets[name] = value; atomicWrite(this.path, JSON.stringify(data)); }); }
  deleteSecret(name: string): Promise<void> { return this.serialized(async () => { const data = this.load(); delete data.secrets[name]; atomicWrite(this.path, JSON.stringify(data)); }); }
  selectOpenai(key: string): Promise<void> { return this.serialized(async () => { const data = this.load(); if (!/^(?:openai(?:-api)?|chatgpt:[a-z0-9-]{1,40})$/.test(key) || !data.entries[key]) throw new Error('Unknown OpenAI account'); data.activeOpenai = key; atomicWrite(this.path, JSON.stringify(data)); }); }
  async activeAccount(): Promise<string> { await this.tail; return this.load().activeOpenai ?? 'openai'; }
}
