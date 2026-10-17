import { readFile, unlink, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Store, hash, id } from './store.js';
import { atomicWrite } from './config.js';
import { Credentials } from './credentials.js';
import type { EmbeddingProvider } from './contracts.js';

export function safeName(name: string): string { return basename(name.replaceAll('\\', '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'attachment'; }
export function mediaType(bytes: Uint8Array, declared: string): string {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 3).toString() === 'ID3' || buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0 && (buffer[1]! & 0x06) !== 0) return 'audio/mpeg';
  if (buffer.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (buffer.subarray(4, 8).toString() === 'ftyp' && ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42', 'qt  '].includes(buffer.subarray(8, 12).toString())) return declared.startsWith('audio/') ? 'audio/mp4' : 'video/mp4';
  if (buffer.subarray(0,4).toString()==='RIFF' && buffer.subarray(8,12).toString()==='WAVE')return 'audio/wav';
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if(declared==='text/csv'||declared==='application/csv')return 'application/csv'; // AnyDoc verifies CSV encoding/delimiters, including UTF-16.
  if (declared.startsWith('text/') || declared === 'application/json') {
    new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (buffer.includes(0)) throw new Error('Binary document declared as text');
    return declared;
  }
  if (declared.startsWith('image/') || declared.startsWith('audio/')) throw new Error(`Unsupported or unverified media type: ${declared}`);
  // Acceptance preserves opaque originals; conversion establishes the actual document format later.
  return 'application/octet-stream';
}
export class Media {
  private volatile = new Map<string, { bytes: Uint8Array; mime: string; name: string; transcript?: string; status?: string }>();
  constructor(readonly store: Store, readonly credentials: Credentials) {}
  save(bytes: Uint8Array, name: string, declared: string, conversationId?: string, ephemeral = false, stableId = id()): string {
    if (bytes.length > this.store.config.limits.attachmentBytes) throw new Error('Attachment size limit exceeded');
    const mime = mediaType(bytes, declared);
    if (ephemeral) { this.volatile.set(stableId, { bytes, mime, name: safeName(name) }); return stableId; }
    const existing=this.store.get<{hash:string}>('SELECT hash FROM attachments WHERE id=?',stableId);
    if (existing) { if(existing.hash!==hash(bytes))throw new Error('Attachment ID reused for changed bytes');return stableId; }
    if(!/^[a-zA-Z0-9-]+$/.test(stableId))throw new Error('Invalid attachment ID');
    atomicWrite(join(this.store.root, 'attachments', stableId), bytes);
    this.store.run('INSERT INTO attachments(id,conversation_id,name,mime,bytes,hash,status,created_at) VALUES(?,?,?,?,?,?,?,?)', stableId, conversationId ?? null, safeName(name), mime, bytes.length, hash(bytes), 'stored', Date.now());
    return stableId;
  }
  async read(attachmentId: string): Promise<{ bytes: Uint8Array; mime: string; name: string; transcript?: string;status?:string }> {
    const volatile = this.volatile.get(attachmentId);
    if (volatile) return volatile;
    const row = this.store.get<{ id: string; mime: string; name: string; transcript: string | null; hash: string;bytes:number;status:string }>('SELECT * FROM attachments WHERE id=?', attachmentId);
    if (!row) throw new Error('Attachment not found in this instance');
    if(row.status==='expired')throw new Error('Original media expired under retention policy; sourced derivative/metadata may still be retained');
    if(!/^[a-zA-Z0-9-]+$/.test(row.id))throw new Error('Unsafe attachment identity');
    const path=join(this.store.root,'attachments',row.id),stat=await lstat(path);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size!==row.bytes)throw new Error('Attachment integrity failure');
    const bytes = await readFile(path);
    if (hash(bytes) !== row.hash) throw new Error('Attachment integrity failure');
    return { bytes, mime: row.mime, name: row.name, transcript: row.transcript ?? undefined,status:row.status };
  }
  async discardUnlinked(attachmentId:string):Promise<void>{if(this.volatile.delete(attachmentId))return;const row=this.store.get<{source_id:string|null}>('SELECT source_id FROM attachments WHERE id=?',attachmentId);if(!row||row.source_id)return;this.store.run('DELETE FROM retrieval WHERE id=?',`media:${attachmentId}`);this.store.run('DELETE FROM attachments WHERE id=?',attachmentId);await unlink(join(this.store.root,'attachments',attachmentId));}
  link(attachmentId: string, sourceId: string, conversationId: string): void { this.store.run('UPDATE attachments SET source_id=?,conversation_id=? WHERE id=?', sourceId, conversationId, attachmentId); }
  async transcribe(attachmentId: string,signal?:AbortSignal): Promise<string> {
    const media = await this.read(attachmentId);
    if(media.transcript)return media.transcript;
    if(media.status==='transcription_uncertain'||media.status==='transcribing')throw new Error('Earlier transcription acceptance is unknown; not automatically billed/replayed. Resend explicitly to authorize a fresh transcription.');
    const config = this.store.config.transcription, key = await this.credentials.secret('openai.mediaKey');
    if (!config || !key) throw new Error('Voice transcription unavailable. Configure an OpenAI API key or dedicated media key; ChatGPT subscription does not authorize transcription.');
    if(!media.mime.startsWith('audio/'))throw new Error('Only verified audio can be transcribed');
    const form = new FormData();
    form.set('model', config.model); form.set('file', new Blob([new Uint8Array(media.bytes)], { type: media.mime }), media.name);
    const setStatus = (status: string) => {
      const volatile = this.volatile.get(attachmentId);
      if (volatile) volatile.status = status;
      else this.store.run('UPDATE attachments SET status=? WHERE id=?', status, attachmentId);
    };
    setStatus('transcribing');
    let response:Response;
    try{response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60_000)]):AbortSignal.timeout(60_000)});}
    catch(error){setStatus('transcription_uncertain');throw new Error('Transcription acceptance unknown; not automatically replayed', { cause: error });}
    if (!response.ok) { setStatus('transcription_failed'); throw new Error(`Transcription failed: HTTP ${response.status}`); }
    let data: { text?: unknown };
    try { data = await response.json() as { text?: unknown }; }
    catch { setStatus('transcription_uncertain'); throw new Error('Invalid transcription response; not automatically replayed'); }
    if (typeof data?.text !== 'string' || !data.text.trim()) { setStatus('transcription_failed'); throw new Error('No intelligible transcript returned'); }
    const volatile = this.volatile.get(attachmentId);
    if (volatile) { volatile.transcript = data.text; volatile.status = 'transcribed'; }
    else this.store.run("UPDATE attachments SET transcript=?,status='transcribed' WHERE id=?", data.text, attachmentId);
    return data.text;
  }
  async speak(text: string, parent?: AbortSignal): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
    if (!text.trim() || text.length > 4096) throw new Error('Voice replies require 1–4096 characters of spoken text');
    const config = this.store.config.speech;
    if (!config) throw new Error('Voice replies are disabled. Configure /settings speech; separate OpenAI API charges apply.');
    const key = await this.credentials.secret('openai.speechKey');
    if (!key) throw new Error('Voice replies need an OpenAI API key or /auth secret openai.speechKey, not a ChatGPT subscription.');
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(parent ? [parent] : [])]);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, voice: config.voice, input: text, response_format: 'opus' }), signal });
    } catch { throw new Error('Speech generation acceptance unknown; a charge may have occurred. Do not automatically retry.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Speech generation failed: HTTP ${response.status}; not automatically retried`); }
    const limit = this.store.config.limits.attachmentBytes, chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (!response.body || Number(response.headers.get('content-length')) > limit) throw new Error('Invalid speech response');
      const reader = response.body.getReader();
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read(); if (done) break;
          length += value.length; if (length > limit) throw new Error('Speech response limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { await response.body?.cancel().catch(() => {}); throw new Error('Speech response unreadable or exceeds limits; may have been billed. Do not automatically retry.'); }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    if (bytes.subarray(0, 4).toString() !== 'OggS' || !bytes.subarray(0, 512).includes(Buffer.from('OpusHead'))) throw new Error('Expected Ogg Opus speech; may have been billed. Do not automatically retry.');
    return { bytes, name: 'reply.ogg', mime: 'audio/ogg' };
  }
  async expire(): Promise<void> {
    const cutoff = Date.now() - this.store.config.retention.mediaDays * 86_400_000, errors: unknown[] = [];
    for (const a of this.store.all<{ id: string }>("SELECT id FROM attachments WHERE created_at<? AND status!='expired'", cutoff)) {
      try { await unlink(join(this.store.root, 'attachments', a.id)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { errors.push(error); continue; } }
      this.store.run("UPDATE attachments SET status='expired' WHERE id=?", a.id);
    }
    if (errors.length) throw new AggregateError(errors,'Media expiry failed; affected files remain queued for retry');
  }
  clearVolatile(): void { this.volatile.clear(); }
}
export class OpenaiEmbeddings implements EmbeddingProvider {
  readonly version = '1';
  readonly usage = { requests: 0, tokens: 0 };
  constructor(readonly model: string, readonly dimensions: number, readonly credentials: Credentials) {}
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    const key = await this.credentials.secret('openai.embeddingKey');
    if (!key) throw new Error('OpenAI API key or dedicated embedding key not configured');
    const response = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions, encoding_format: 'float' }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Embedding request failed: HTTP ${response.status}`);
    const data = await response.json() as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error('Embedding response count mismatch');
    const ordered = data.data.sort((a, b) => a.index - b.index);
    if (ordered.some((item, index) => item.index !== index || !Array.isArray(item.embedding) || item.embedding.length !== this.dimensions || !item.embedding.every(Number.isFinite))) throw new Error('Invalid embedding response');
    this.usage.requests++; this.usage.tokens += data.usage?.total_tokens ?? 0;
    return ordered.map(d => d.embedding);
  }
}
