import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { object, validate, type Envelope } from './contracts.js';
import { Store, hash, json } from './store.js';
import type { Media } from './media.js';
import type { Credentials } from './credentials.js';
import type { Knowledge } from './knowledge.js';
import { mediaType } from './media.js';

export const ImageGenerateSchema = object({ prompt: Type.String({ minLength: 1, maxLength: 6000 }), size: Type.Optional(Type.Union(['1024x1024','1536x1024','1024x1536'].map(value => Type.Literal(value)))) });
export const ImageIdentitySchema = object({ id: Type.String({ pattern: '^[a-f0-9-]{36}$' }) });
export const ImageShowSchema = object({ attachmentId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9-]+$', minLength: 1, maxLength: 200 })), documentId: Type.Optional(ImageIdentitySchema.properties.id!), revision: Type.Optional(Type.Integer({ minimum: 1 })) });
export type ImageReference = { attachmentId: string; documentId?: never; revision?: never } | { documentId: string; revision: number; attachmentId?: never };
export const ImageListSchema = object({ conversationId: Type.Optional(Type.String({ maxLength: 200 })), runId: Type.Optional(Type.String({ maxLength: 200 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) });
interface ImageRow { attachment_id: string; prompt: string; model: string; quality: string; size: string; usage: string; created_at: number; name: string; mime: string; bytes: number; hash: string; status: string }
export function generatedImageSource(store: Store, sourceId: string) {
  const match = /^image:([a-f0-9-]{36})$/.exec(sourceId);
  const row = match ? store.get<ImageRow>('SELECT i.*,a.name,a.mime,a.bytes,a.hash,a.status FROM generated_images i JOIN attachments a ON a.id=i.attachment_id WHERE i.attachment_id=?',match[1]!) : undefined;
  if (!row) return undefined;
  return { id:sourceId,text:`Synthetic image generated from prompt: ${row.prompt}`,actor:`assistant:${store.config.instanceId}`,event_at:row.created_at,recorded_at:row.created_at,eventTime:new Date(row.created_at).toISOString(),recordedTime:new Date(row.created_at).toISOString(),generated:true,provider:'openai',model:row.model,quality:row.quality,size:row.size,usage:JSON.parse(row.usage),media:[{id:row.attachment_id,name:row.name,mime:row.mime,bytes:row.bytes,hash:row.hash,status:row.status}],evidence:'Model-generated synthetic content, not a photograph, owner assertion or factual evidence.' };
}
export function cleanupGeneratedImages(store: Store): void {
  if (store.db.isTransaction) throw new Error('Generated image cleanup requires committed state');
  for (const row of store.all<{key:string}>('SELECT key FROM meta WHERE key LIKE \'images.unlink:%\'')) {
    const attachmentId = row.key.slice('images.unlink:'.length);
    if (!/^[a-f0-9-]{36}$/.test(attachmentId) || store.get('SELECT id FROM attachments WHERE id=?',attachmentId)) throw new Error('Invalid generated image erasure journal');
    rmSync(join(store.root,'attachments',attachmentId),{force:true}); store.run('DELETE FROM meta WHERE key=?',row.key);
  }
}
export class Images {
  private shutdown = new AbortController();
  constructor(readonly store: Store, private credentials: Credentials, private media: Media, private epoch: () => number, private knowledge: Knowledge) { cleanupGeneratedImages(store); }
  private current(signal: AbortSignal, epoch: number): void { signal.throwIfAborted(); if (this.epoch() !== epoch) throw new Error('Image work invalidated by shutdown/source erasure'); }
  metadata(attachmentId: string) {
    const source = generatedImageSource(this.store,`image:${attachmentId}`);
    if (!source) throw new Error('Generated image not found in this instance');
    return { attachmentId,sourceId:source.id,...source.media[0]!,provider:source.provider,model:source.model,quality:source.quality,size:source.size,prompt:source.text,generatedAt:source.eventTime,usage:source.usage,synthetic:true };
  }
  list(raw: unknown) {
    const a = validate<{conversationId?:string;runId?:string;offset?:number;limit?:number}>(ImageListSchema,raw), offset=a.offset ?? 0,limit=a.limit ?? 20;
    const where='(? IS NULL OR a.conversation_id=?) AND (? IS NULL OR i.run_id=?)',args=[a.conversationId ?? null,a.conversationId ?? null,a.runId ?? null,a.runId ?? null];
    const total=this.store.get<{n:number}>(`SELECT count(*) n FROM generated_images i JOIN attachments a ON a.id=i.attachment_id WHERE ${where}`,...args)!.n;
    const images=this.store.all<{attachment_id:string}>(`SELECT i.attachment_id FROM generated_images i JOIN attachments a ON a.id=i.attachment_id WHERE ${where} ORDER BY i.created_at DESC,i.attachment_id LIMIT ? OFFSET ?`,...args,limit,offset).reverse().map(row=>this.metadata(row.attachment_id));
    return {total,offset,nextOffset:offset+limit<total?offset+limit:null,images};
  }
  async read(attachmentId: string) { const metadata=this.metadata(attachmentId),image=await this.media.read(attachmentId); return {...metadata,data:Buffer.from(image.bytes).toString('base64')}; }
  private async original(raw: unknown) {
    const a=validate<{attachmentId?:string;documentId?:string;revision?:number}>(ImageShowSchema,raw);
    if (!!a.attachmentId === !!a.documentId || a.revision !== undefined && !a.documentId) throw new Error('Choose one image attachment or document original; revision requires documentId');
    let reference:ImageReference, bytes:Uint8Array, name:string, mime:string, sourceId:string|undefined, synthetic=false;
    if (a.attachmentId) {
      const row=this.store.get<{source_id:string|null}>('SELECT source_id FROM attachments WHERE id=?',a.attachmentId);
      if(!row)throw new Error('Retained image attachment not found in this instance');
      const media=await this.media.read(a.attachmentId);
      ({bytes,name,mime}=media);reference={attachmentId:a.attachmentId};sourceId=row.source_id??undefined;
      synthetic=!!this.store.get('SELECT attachment_id FROM generated_images WHERE attachment_id=?',a.attachmentId);
    } else {
      const revision=a.revision??this.knowledge.document(a.documentId!).current_revision;
      ({bytes,name,mime}=this.knowledge.original(a.documentId!,revision));
      reference={documentId:a.documentId!,revision};sourceId=`document:${a.documentId}:r${revision}`;
    }
    if(bytes.length>this.store.config.limits.attachmentBytes)throw new Error('Image preview exceeds attachment limit');
    mime=mediaType(bytes,mime);
    if(!['image/png','image/jpeg','image/gif','image/webp'].includes(mime))throw new Error('Preview requires a supported image, not another file type');
    return {...reference,name,mime,bytes:bytes.length,sourceId,synthetic,original:bytes};
  }
  async preview(raw: unknown) {
    const epoch=this.epoch(),{original,...image}=await this.original(raw);
    const bytes=image.mime==='image/png'?original:await this.knowledge.converter.request<Uint8Array>('image-preview',{bytes:original,mime:image.mime},this.shutdown.signal);
    this.current(this.shutdown.signal,epoch);
    return {...image,mime:'image/png',bytes:bytes.length,data:Buffer.from(bytes).toString('base64')};
  }
  async show(raw: unknown, context: Envelope, parent?: AbortSignal) {
    if(context.ownerId!==this.store.config.ownerId||context.instanceId!==this.store.config.instanceId)throw new Error('Image ownership mismatch');
    if(!context.source.trustedOwner||context.mode!=='foreground')throw new Error('Image replies require trusted retained owner foreground work');
    const epoch=this.epoch(),signal=AbortSignal.any([this.shutdown.signal,...(parent?[parent]:[])]);
    this.current(signal,epoch);
    const {original: _original,...image}=await this.original(raw);
    this.current(signal,epoch);
    if(image.sourceId)this.store.linkSource(context.runId,image.sourceId);
    return {...image,displayed:true,note:'Image made available in this conversation. Preview availability is not a Telegram delivery receipt or proof of image contents.'};
  }
  previews(conversationId: string, runId?: string): { images: ImageReference[] } {
    const rows=this.store.all<{attachmentId:string|null;documentId:string|null;revision:number|null}>(`SELECT json_extract(o.result,'$.details.attachmentId') attachmentId,json_extract(o.result,'$.details.documentId') documentId,json_extract(o.result,'$.details.revision') revision
      FROM operations o JOIN runs r ON r.id=o.run_id WHERE r.conversation_id=? AND (? IS NULL OR o.run_id=?) AND o.tool IN('$images.generate','$images.show') AND o.status='completed' AND o.result IS NOT NULL
      GROUP BY attachmentId,documentId,revision ORDER BY max(o.rowid) DESC LIMIT 3`,conversationId,runId??null,runId??null);
    return {images:rows.reverse().map(row=>row.attachmentId?{attachmentId:row.attachmentId}:{documentId:row.documentId!,revision:row.revision!})};
  }
  async generate(raw: unknown, context: Envelope, parent?: AbortSignal) {
    if (context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId) throw new Error('Image ownership mismatch');
    if (!context.source.trustedOwner || context.mode !== 'foreground') throw new Error('Image generation requires trusted retained owner foreground work');
    const a=validate<{prompt:string;size?:string}>(ImageGenerateSchema,raw);
    if (!a.prompt.trim()) throw new Error('Image prompt cannot be blank');
    const config=this.store.config.imageGeneration;
    if (!config) throw new Error('Image generation is disabled. Enable /settings imageGeneration and configure an OpenAI API key or masked openai.imageKey. API charges apply; no subscription/provider fallback.');
    if ((this.store.get<{n:number}>("SELECT count(*) n FROM operations WHERE run_id=? AND tool='$images.generate'",context.runId)?.n ?? 0)>1) throw new Error('Only one image generation attempt per run; uncertain requests are not automatically rebilled');
    const epoch=this.epoch(),signal=AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(90_000),...(parent?[parent]:[])]);
    const key=await this.credentials.secret('openai.imageKey'); this.current(signal,epoch);
    if (!key) throw new Error('OpenAI image API key missing; use /auth secret openai.imageKey or /auth key openai. ChatGPT subscriptions and chat-provider keys are not image credentials.');
    const size=a.size ?? '1024x1024',quality=config.quality ?? 'low';
    let response:Response;
    try { response=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:json({model:config.model,prompt:a.prompt,n:1,size,quality,output_format:'png'}),signal}); }
    catch { throw new Error('Image generation acceptance unknown; no automatic retry. A provider charge may already have occurred.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Image generation failed: HTTP ${response.status}; response body not exposed or automatically retried`); }
    const limit=Math.ceil(this.store.config.limits.attachmentBytes/3)*4+65_536,chunks:Uint8Array[]=[];
    let length=0,text:string;
    try {
      if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || Number(response.headers.get('content-length'))>limit) throw new Error('Invalid image response');
      const reader=response.body.getReader();
      try { for (;;) { this.current(signal,epoch); const {done,value}=await reader.read(); if(done)break; length+=value.length; if(length>limit)throw new Error('Image response limit'); chunks.push(value); } }
      finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
      text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      if(text.includes(key))throw new Error('Reflected image credential');
    } catch { await response.body?.cancel().catch(()=>{}); this.current(signal,epoch); throw new Error('Image response unreadable or exceeds limits; request may have been billed, not automatically retried'); }
    let data:any;
    try { data=JSON.parse(text); } catch { throw new Error('Invalid image response; not automatically retried'); }
    const encoded=data?.data?.[0]?.b64_json;
    if (!Array.isArray(data?.data) || data.data.length!==1 || typeof encoded!=='string' || encoded.length>Math.ceil(this.store.config.limits.attachmentBytes/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length%4) throw new Error('Expected one bounded base64 PNG, not a remote image URL; request not automatically retried');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded || bytes.length>this.store.config.limits.attachmentBytes || bytes.length<33 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(12,16).toString()!=='IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16)>1536 || bytes.readUInt32BE(20)>1536) throw new Error('Invalid or oversized generated PNG; not automatically retried');
    const usage=Object.fromEntries(['input_tokens','output_tokens','total_tokens'].flatMap(field=>Number.isSafeInteger(data.usage?.[field]) && data.usage[field]>=0?[[field,data.usage[field]]]:[]));
    this.current(signal,epoch);
    const attachmentId=crypto.randomUUID();
    // Keep file cleanup recoverable if persistence fails or the process dies before commit.
    this.store.setMeta(`images.unlink:${attachmentId}`,'pending');
    try { this.store.transaction(()=>{
      const dependencies=this.store.all<{source_id:string}>("SELECT source_id FROM run_sources WHERE run_id=? UNION SELECT id source_id FROM messages WHERE run_id=? AND role='user'",context.runId,context.runId);
      if(dependencies.some(row=>this.store.get('SELECT hash FROM deletions WHERE hash=?',hash(`source:${row.source_id}`))))throw new Error('Image input evidence was erased');
      this.media.save(bytes,`generated-${attachmentId}.png`,'image/png',context.conversationId,false,attachmentId);
      this.media.link(attachmentId,`image:${attachmentId}`,context.conversationId);
      this.store.run('INSERT INTO generated_images VALUES(?,?,?,?,?,?,?,?)',attachmentId,context.runId,a.prompt,config.model,quality,size,json(usage),Date.now());
      for(const dependency of dependencies)this.store.run('INSERT OR IGNORE INTO generated_image_sources VALUES(?,?)',attachmentId,dependency.source_id);
      this.store.run('DELETE FROM meta WHERE key=?',`images.unlink:${attachmentId}`);
    }); } catch(error) { cleanupGeneratedImages(this.store); throw error; }
    return {...this.metadata(attachmentId),note:'Generated image saved; synthetic content, not factual evidence. Provider token usage is not an invoice. Cancellation cannot undo accepted charges.'};
  }
  close(): void { this.shutdown.abort(new Error('Image service shutting down')); }
}
