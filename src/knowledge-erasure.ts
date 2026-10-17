import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store, hash, id, json } from './store.js';
import { atomicWrite, privateDirectory } from './config.js';
import { purgeDerived, purgeAssistantContext, erasureScope, type ErasureScope } from './memory.js';
import { cleanupGeneratedImages } from './images.js';
import { cleanupSkills } from './skills.js';

/**
 * Remove the conversation context that was derived from erased sources instead of wiping every
 * instance-wide history. Only runs whose context actually reached an erased source lose their
 * assistant/tool messages, summaries and deliveries; other conversations are untouched.
 */
export function purgeErasedContext(store:Store,scope:ErasureScope):void {
  const runs=[...scope.runs];if(!runs.length)return;
  const ids=json(runs);
  const deliveries=store.all<{id:string}>("SELECT id FROM outbox WHERE id IN(SELECT 'reply:'||value FROM json_each(?)) OR id IN(SELECT 'task:'||id FROM occurrences WHERE run_id IN(SELECT value FROM json_each(?)))",ids,ids);
  if(deliveries.length){const outbox=json(deliveries.map(row=>row.id));store.run('DELETE FROM feedback WHERE notification_id IN(SELECT value FROM json_each(?))',outbox);store.run('DELETE FROM outbox WHERE id IN(SELECT value FROM json_each(?))',outbox);}
  store.run("DELETE FROM retrieval WHERE source_id IN(SELECT m.id FROM messages m JOIN json_each(?) ON json_each.value=m.run_id WHERE m.role!='user')",ids);
  store.run("DELETE FROM reviews WHERE source_id IN(SELECT m.id FROM messages m JOIN json_each(?) ON json_each.value=m.run_id WHERE m.role!='user')",ids);
  store.run("DELETE FROM messages WHERE role!='user' AND run_id IN(SELECT value FROM json_each(?))",ids);
  store.run("UPDATE runs SET partial='',status=CASE WHEN status='completed' THEN 'interrupted' ELSE status END,error=CASE WHEN status='completed' THEN 'Derived response erased by source erasure; previously accepted effects may remain' ELSE error END WHERE id IN(SELECT value FROM json_each(?))",ids);
  store.run('UPDATE operations SET result=NULL WHERE run_id IN(SELECT value FROM json_each(?))',ids);
  store.run("DELETE FROM skill_reviews WHERE run_id IN(SELECT value FROM json_each(?))",ids);
  store.run("DELETE FROM media_derivatives WHERE source_id NOT IN(SELECT id FROM messages)");
  store.run("UPDATE conversations SET summary='' WHERE id IN(SELECT DISTINCT conversation_id FROM runs WHERE id IN(SELECT value FROM json_each(?)))",ids);
  store.run('DELETE FROM context_checkpoints WHERE conversation_id IN(SELECT DISTINCT conversation_id FROM runs WHERE id IN(SELECT value FROM json_each(?)))',ids);
}

/**
 * Owner-visible documents that erasing this document would also remove. Computed by running the
 * erasure inside a rolled-back transaction with dependent documents deferred, so it cannot guess.
 */
export function previewDocumentErasure(store:Store,documentId:string,forget:boolean):{id:string;title:string}[] {
  const scope=erasureScope(true);
  class DryRun {}
  try {
    store.transaction(()=>{eraseDocument(store,documentId,forget,scope);throw new DryRun();});
  } catch(error) { if(!(error instanceof DryRun)) throw error; }
  return [...scope.deferred].filter(([id])=>id!==documentId).map(([id,title])=>({id,title}));
}
export function eraseDocument(store:Store,documentId:string,forget:boolean,scope:ErasureScope=erasureScope()):void {
  const doc=store.get<{attachment_id:string|null;kind:string;source_id:string|null;channel:string}>('SELECT * FROM documents WHERE id=?',documentId);if(!doc)return;
  const defer=store.db.isTransaction;
  const conversions=store.all<{conversion:string|null}>('SELECT conversion FROM document_revisions WHERE document_id=?',documentId).map(row=>JSON.parse(row.conversion??'{}') as {sourceAttachmentId?:string;converter?:{name:string};options?:{sourceId?:string}});
  const externalSource=forget&&doc.source_id&&(doc.channel==='integration'||conversions.some(conversion=>conversion.converter?.name==='external-snapshot'&&conversion.options?.sourceId===doc.source_id))?doc.source_id:null;
  const copies=forget&&doc.kind==='import'?store.all<{id:string}>(`SELECT DISTINCT d.id FROM documents d JOIN document_revisions r ON r.document_id=d.id WHERE d.kind='import' AND d.deleted_at IS NULL AND d.id!=? AND (r.original_hash IN(SELECT original_hash FROM document_revisions WHERE document_id=?) OR d.source_id=?)`,documentId,documentId,externalSource):[];
  const attachments=new Set<string>(doc.attachment_id?[doc.attachment_id]:[]);
  for(const conversion of conversions)if(conversion.sourceAttachmentId)attachments.add(conversion.sourceAttachmentId);
  const updates=store.all<{submission:string}>('SELECT submission FROM documents WHERE attachment_id IN(SELECT value FROM json_each(?))',json([...attachments])).flatMap(row=>{const match=/^input:\["telegram",[^\]]*"update:(\d+)"\]/.exec(row.submission);return match?[match[1]!]:[];});
  store.transaction(()=>{
    store.run("UPDATE documents SET deleted_at=?,title='',name='',description='' WHERE id=?",Date.now(),documentId);
    store.run('DELETE FROM family_shares WHERE document_id=?',documentId);
    const queued=JSON.parse(store.meta(`knowledge.unlink:${documentId}`)??'[]') as string[];
    store.setMeta(`knowledge.unlink:${documentId}`,json([...new Set([...queued,...attachments])]));
    store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)',hash(`document:${documentId}`),Date.now());
    // A stable external-source tombstone survives backups that predate the first snapshot and future remote revisions.
    if(externalSource){store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)',hash(`source:${externalSource}`),Date.now());purgeDerived(store,externalSource,scope);}
    for(const rev of store.all<{revision:number;original_hash:string}>('SELECT revision,original_hash FROM document_revisions WHERE document_id=?',documentId)) {
      if(forget)store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)',hash(`document-content:${rev.original_hash}`),Date.now());
      const sourceId=`document:${documentId}:r${rev.revision}`;
      store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)',hash(`source:${sourceId}`),Date.now());
      purgeDerived(store,sourceId,scope);
      const sources=store.all<{source_id:string}>('SELECT source_id FROM memories WHERE source_id=? UNION SELECT m.source_id FROM memory_confirmations c JOIN memories m ON m.id=c.memory_id WHERE c.original_source_id=?',sourceId,sourceId);
      for(const source of sources) {
        purgeDerived(store,source.source_id,scope);
        store.run('UPDATE memories SET supersedes=NULL WHERE supersedes IN(SELECT id FROM memories WHERE source_id=?)',source.source_id);
        store.run('DELETE FROM retrieval WHERE source_id=?',source.source_id);
        store.run('DELETE FROM memories WHERE source_id=?',source.source_id);
        if(source.source_id!==sourceId){store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)',hash(`source:${source.source_id}`),Date.now());store.run('DELETE FROM messages WHERE id=?',source.source_id);}
      }
    }
    store.run("UPDATE document_revisions SET note_text=NULL,markdown=NULL,conversion=NULL,representation_hash=NULL,lexical='deleted',semantic='deleted' WHERE document_id=?",documentId);
    store.run("UPDATE document_jobs SET status='cancelled',error=NULL WHERE document_id=?",documentId);
    for(const attachmentId of attachments) {
      store.run('DELETE FROM retrieval WHERE id=? OR id LIKE ?',`media:${attachmentId}`,`media:${attachmentId}:chunk:%`);
      store.run('DELETE FROM attachments WHERE id=?',attachmentId);
    }
    // Raw inbound payloads are only cleared for the updates that carried the erased originals.
    if(updates.length)store.run("UPDATE telegram_updates SET data='{}' WHERE id IN(SELECT value FROM json_each(?))",json(updates));
    purgeAssistantContext(store,scope);
    purgeErasedContext(store,scope);
    store.setMeta('knowledge.dirty',id());store.setMeta('knowledge.cleanup',id());
    for(const copy of copies)if(store.get('SELECT id FROM documents WHERE id=? AND deleted_at IS NULL',copy.id))eraseDocument(store,copy.id,true,scope);
  });
  if(!defer)cleanupErasedDocuments(store);
}
export function cleanupErasedDocuments(store:Store):void {
  if(store.db.isTransaction)throw new Error('Physical document erasure requires committed state');
  cleanupGeneratedImages(store);
  cleanupSkills(store);
  const queued=store.all<{key:string;value:string}>("SELECT key,value FROM meta WHERE key LIKE 'knowledge.unlink:%'");if(!queued.length)return;
  atomicWrite(join(store.root,'deletion-ledger.json'),json(store.all<{hash:string}>('SELECT hash FROM deletions').map(row=>row.hash)));
  privateDirectory(join(store.root,'knowledge'));privateDirectory(join(store.root,'knowledge','objects'));privateDirectory(join(store.root,'knowledge','searchable'));
  rmSync(join(store.root,'backups'),{recursive:true,force:true});privateDirectory(join(store.root,'backups'));
  for(const row of queued) {
    const documentId=row.key.slice('knowledge.unlink:'.length);
    if(!/^[a-f0-9-]{36}$/.test(documentId)||!store.get('SELECT id FROM documents WHERE id=? AND deleted_at IS NOT NULL',documentId))throw new Error('Invalid erasure journal');
    rmSync(join(store.root,'knowledge','objects',documentId),{recursive:true,force:true});
    for(const rev of store.all<{revision:number}>('SELECT revision FROM document_revisions WHERE document_id=?',documentId))rmSync(join(store.root,'knowledge','searchable',`${documentId}-r${rev.revision}.md`),{force:true});
    for(const attachmentId of JSON.parse(row.value) as string[]){if(!/^[a-zA-Z0-9-]+$/.test(attachmentId)||store.get('SELECT id FROM attachments WHERE id=?',attachmentId))throw new Error('Invalid attachment erasure journal');rmSync(join(store.root,'attachments',attachmentId),{force:true});}
    store.run('DELETE FROM meta WHERE key=?',row.key);
  }
}
