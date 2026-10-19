import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { mkdir, copyFile, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { purgeDerived, purgeAssistantContext, erasureScope } from './memory.js';
import { eraseDocument, purgeErasedContext } from './knowledge-erasure.js';
import { Store, hash, id, json, acquireLock } from './store.js';
import { hashEvent } from './calendar.js';
import { cleanupGeneratedImages } from './images.js';
import { atomicWrite, privateDirectory, loadConfig } from './config.js';
import { Skills, cleanupSkills, skillSourceId } from './skills.js';

export function knowledgeFiles(store: Store): {path:string;hash:string}[] {
  const files:{path:string;hash:string}[]=[];
  for(const row of store.all<{document_id:string;revision:number;original_hash:string;conversion:string|null}>('SELECT r.* FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.deleted_at IS NULL')) {
    if(!/^[a-f0-9-]{36}$/.test(row.document_id)||!Number.isSafeInteger(row.revision)||row.revision<1)throw new Error('Invalid knowledge identity in snapshot');
    const base=`knowledge/objects/${row.document_id}/${row.revision}`;
    files.push({path:`${base}/original`,hash:row.original_hash});
    const conversion=JSON.parse(row.conversion??'{}') as {assets?:{id:number;hash:string}[]};
    for(const asset of conversion.assets??[]){if(!Number.isSafeInteger(asset.id)||asset.id<0)throw new Error('Invalid knowledge asset');files.push({path:`${base}/assets/${asset.id}`,hash:asset.hash});}
  }return files;
}
interface BackupManifest { version: 1; ownerId: string; instanceId: string; createdAt: number; files: { path: string; hash: string }[]; credentials: 'excluded' }
export async function backup(store: Store): Promise<{ path: string; manifest: BackupManifest }> {
  const skills = new Skills(store); skills.sync(); skills.validateStorage();
  const destination = join(store.root, 'backups', `${new Date().toISOString().replaceAll(':','-')}-${id()}`);
  await mkdir(join(destination, 'attachments'), { recursive: true, mode: 0o700 });
  try {
    await sqliteBackup(store.db, join(destination, 'pikobot.sqlite'));
    const snapshot = new DatabaseSync(join(destination, 'pikobot.sqlite'), { readOnly: true });
    const attachments = snapshot.prepare("SELECT id,hash FROM attachments WHERE status!='expired'").all() as { id: string; hash: string }[];
    snapshot.close();
    const snapshotStore=new Store(destination,store.config);let knowledge:{path:string;hash:string}[];
    try{knowledge=knowledgeFiles(snapshotStore);}finally{snapshotStore.close();}
    const files: BackupManifest['files'] = [];
    for (const attachment of attachments) {
      if (!/^[a-zA-Z0-9-]+$/.test(attachment.id)) throw new Error('Unsafe attachment ID in snapshot');
      const content = await readFile(join(store.root, 'attachments', attachment.id));
      if (hash(content) !== attachment.hash) throw new Error('Attachment changed or disappeared during backup; retry');
      await writeFile(join(destination,'attachments',attachment.id), content, { mode: 0o600 });
      files.push({ path: `attachments/${attachment.id}`, hash: attachment.hash });
    }
    for(const file of knowledge){const content=await readFile(join(store.root,file.path));if(hash(content)!==file.hash)throw new Error('Knowledge integrity failure during backup');await mkdir(join(destination,file.path,'..'),{recursive:true,mode:0o700});await writeFile(join(destination,file.path),content,{mode:0o600});files.push(file);}
    await copyFile(join(store.root,'config.json'),join(destination,'config.json'));
    for (const path of ['config.json','pikobot.sqlite']) files.push({ path, hash: hash(await readFile(join(destination,path))) });
    if(existsSync(join(store.root,'deletion-ledger.json'))){await copyFile(join(store.root,'deletion-ledger.json'),join(destination,'deletion-ledger.json'));files.push({path:'deletion-ledger.json',hash:hash(await readFile(join(destination,'deletion-ledger.json')))});}
    const manifest: BackupManifest = { version: 1, ownerId: store.config.ownerId, instanceId: store.config.instanceId, createdAt: Date.now(), files, credentials: 'excluded' };
    atomicWrite(join(destination,'manifest.json'),json(manifest));
    const cutoff = Date.now() - store.config.retention.backupDays * 86_400_000;
    for (const name of await readdir(join(store.root,'backups'))) { const path = join(store.root,'backups',name); if (path!==destination&&(await stat(path)).mtimeMs < cutoff) await rm(path,{recursive:true,force:true}); }
    return { path: destination, manifest };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
export function exportData(store: Store): unknown {
  return { format: 'pikobot-export-v1', owner: { id: store.config.ownerId, name: store.config.ownerName }, assistant: { id: `assistant:${store.config.instanceId}`, name: 'Pikobot' },
    conversations: store.all('SELECT * FROM conversations'), messages: store.all('SELECT id,conversation_id,actor,role,text,event_at FROM messages ORDER BY rowid'),
    memories: store.all('SELECT * FROM memories'), memoryEvidence: store.all('SELECT * FROM memory_evidence'), memoryDependencies: store.all('SELECT * FROM memory_dependencies'), memoryTags: store.all('SELECT * FROM memory_tags ORDER BY memory_id,tag'), skills: store.all('SELECT * FROM skills'), schedules: store.all('SELECT * FROM schedules'),
    skillPackages:store.all('SELECT * FROM skill_packages'),skillFiles:store.all<{skill_id:string;version:number;path:string;hash:string;content:Uint8Array;executable:number}>('SELECT * FROM skill_files').map(({content,...file})=>({...file,encoding:'base64',content:Buffer.from(content).toString('base64')})),skillDependencies:store.all('SELECT * FROM skill_sources'),
    calendarEvents:store.all('SELECT * FROM calendar_events'),calendarDependencies:store.all('SELECT * FROM calendar_sources'),
    familyMembers:store.all('SELECT * FROM family_peers'),familyShares:store.all('SELECT * FROM family_shares'),familyRequests:store.all('SELECT * FROM family_requests'),familyReminders:store.all('SELECT * FROM family_reminders'),
    extensionStorage:store.all('SELECT * FROM extension_storage'),extensionDependencies:store.all('SELECT * FROM storage_sources'),
    generatedImages:store.all('SELECT * FROM generated_images'),imageDependencies:store.all('SELECT * FROM generated_image_sources'),
    documents:store.all('SELECT * FROM documents'),documentRevisions:store.all('SELECT * FROM document_revisions'),
    webSources:store.all('SELECT id,kind,url,title,text,data,content_hash,text_hash,created_at FROM web_sources'),webDependencies:store.all('SELECT * FROM web_source_dependencies'),
    attachments: store.all('SELECT id,name,mime,bytes,hash,source_id,status FROM attachments'), exportedAt: new Date().toISOString() };
}
export async function restore(rootPath: string, backupPath: string, originalStopped: boolean): Promise<void> {
  if (!originalStopped) throw new Error('Restore requires --confirm-original-stopped; never clone active channels/jobs');
  const { root, config } = loadConfig(rootPath);
  const unlock = acquireLock(root);
  const source = resolve(backupPath), staged = join(root, `restore-${id()}`);
  try {
    const manifest = JSON.parse(await readFile(join(source,'manifest.json'),'utf8')) as BackupManifest;
    if (manifest.version !== 1 || manifest.ownerId !== config.ownerId || manifest.instanceId !== config.instanceId) throw new Error('Backup does not belong to this instance');
    if (!Array.isArray(manifest.files)||!manifest.files.some(file=>file?.path==='config.json')) throw new Error('Missing required backup files');
    if (new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length) throw new Error('Duplicate backup paths');
    // Pre-rename snapshots keep their SQLite basename; validate one DB and stage it under the current name.
    const databases=manifest.files.filter(file=>typeof file.path==='string'&&/^[a-zA-Z0-9_-]+\.sqlite$/.test(file.path));
    if(databases.length!==1)throw new Error('Missing required backup files or ambiguous database');
    const database=databases[0]!.path;
    await mkdir(staged, { mode: 0o700 });
    await mkdir(join(staged,'attachments'), { mode: 0o700 });
    for (const file of manifest.files) {
      if (!['config.json',database,'deletion-ledger.json'].includes(file.path) && !/^attachments\/[a-zA-Z0-9-]+$/.test(file.path) && !/^knowledge\/objects\/[a-f0-9-]{36}\/[1-9][0-9]*\/(original|assets\/[0-9]+)$/.test(file.path)) throw new Error('Invalid backup path');
      const content = await readFile(join(source,file.path));
      if (hash(content) !== file.hash) throw new Error('Backup integrity failure');
      await mkdir(join(staged,file.path,'..'),{recursive:true,mode:0o700});
      await writeFile(join(staged,file.path===database?'pikobot.sqlite':file.path),content,{mode:0o600});
    }
    const stagedStore=new Store(staged,config),db=stagedStore.db;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON');
    const metadata = Object.fromEntries((db.prepare('SELECT key,value FROM meta').all() as {key:string;value:string}[]).map(row => [row.key,row.value]));
    if (metadata.ownerId !== config.ownerId || metadata.instanceId !== config.instanceId) { db.close(); throw new Error('Database ownership differs from backup manifest'); }
    for (const attachment of db.prepare('SELECT id,hash,status FROM attachments').all() as {id:string;hash:string;status:string}[]) {
      if (!/^[a-zA-Z0-9-]+$/.test(attachment.id) || attachment.status!=='expired'&&!manifest.files.some(file => file.path === `attachments/${attachment.id}` && file.hash === attachment.hash)) { db.close(); throw new Error('Missing or invalid attachment reference in backup'); }
    }
    new Skills(stagedStore).validateStorage();
    for(const file of knowledgeFiles(stagedStore))if(!manifest.files.some(entry=>entry.path===file.path&&entry.hash===file.hash)){db.close();throw new Error('Missing knowledge reference in backup');}
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) { db.close(); throw new Error('Backup database integrity failure'); }
    const ledger = new Set<string>();
    if (existsSync(join(root,'pikobot.sqlite'))) { const current = new Store(root,config); try { for (const row of current.all<{hash:string}>('SELECT hash FROM deletions')) ledger.add(row.hash); } finally { current.close(); } }
    for (const path of [join(root,'deletion-ledger.json'),...(manifest.files.some(f=>f.path==='deletion-ledger.json')?[join(staged,'deletion-ledger.json')]:[])]) if (existsSync(path)) for (const entry of JSON.parse(await readFile(path,'utf8')) as string[]) ledger.add(entry);
    for (const row of db.prepare('SELECT hash FROM deletions').all() as { hash: string }[]) ledger.add(row.hash);
    const sources = new Set<string>();
    for (const row of db.prepare('SELECT id,text FROM messages').all() as { id: string; text: string }[]) if (ledger.has(hash(row.text)) || ledger.has(hash(`source:${row.id}`))) sources.add(row.id);
    for (const row of db.prepare('SELECT entity,key,scope,source_id FROM memories').all() as { entity: string; key: string;scope:string; source_id: string }[]) if (ledger.has(hash(`memory:${row.entity}:${row.key}`))||ledger.has(hash(`memory:${row.entity}:${row.key}:${row.scope}`))) sources.add(row.source_id);
    for (const entry of stagedStore.all<{id:string}>('SELECT id FROM web_sources')) {
      const web=stagedStore.get<{id:string;url:string;content_hash:string;body:Uint8Array;text:string;text_hash:string}>('SELECT * FROM web_sources WHERE id=?',entry.id)!;
      if (hash(web.body)!==web.content_hash || hash(web.text)!==web.text_hash) { db.close(); throw new Error('Web snapshot integrity failure in backup'); }
      if (ledger.has(hash(`source:${web.id}`)) || ledger.has(hash(`web-content:${web.content_hash}`)) || ledger.has(hash(`web-url:${web.url}`))) sources.add(web.id);
    }
    for (const dependency of stagedStore.all<{source_id:string}>('SELECT DISTINCT source_id FROM web_source_dependencies')) if (ledger.has(hash(`source:${dependency.source_id}`))) sources.add(dependency.source_id);
    for (const event of stagedStore.all<{id:string}>('SELECT id FROM calendar_events')) {
      if (ledger.has(hashEvent(event.id))) sources.add(`calendar:${event.id}`);
      else if (ledger.has(hash(`calendar-record:${event.id}`))) stagedStore.run('DELETE FROM calendar_events WHERE id=?',event.id);
    }
    for (const dependency of stagedStore.all<{source_id:string}>('SELECT DISTINCT source_id FROM calendar_sources')) if (ledger.has(hash(`source:${dependency.source_id}`))) sources.add(dependency.source_id);
    for (const image of stagedStore.all<{attachment_id:string}>('SELECT attachment_id FROM generated_images')) if(ledger.has(hash(`source:image:${image.attachment_id}`)))sources.add(`image:${image.attachment_id}`);
    for (const dependency of stagedStore.all<{source_id:string}>('SELECT DISTINCT source_id FROM generated_image_sources')) if(ledger.has(hash(`source:${dependency.source_id}`)))sources.add(dependency.source_id);
    for(const dependency of stagedStore.all<{source_id:string}>('SELECT DISTINCT source_id FROM storage_sources'))if(ledger.has(hash(`source:${dependency.source_id}`)))sources.add(dependency.source_id);
    for (const row of stagedStore.all<{id:string;version:number;name:string;content_hash:string|null}>('SELECT s.id,s.version,s.name,p.content_hash FROM skills s LEFT JOIN skill_packages p ON p.skill_id=s.id AND p.version=s.version')) if (ledger.has(hash(`source:${skillSourceId(row.id,row.version)}`)) || ledger.has(hash(`skill-name:${row.name}`)) || row.content_hash && ledger.has(hash(`skill-content:${row.content_hash}`))) sources.add(skillSourceId(row.id,row.version));
    for (const row of stagedStore.all<{source_id:string}>('SELECT DISTINCT source_id FROM skill_sources')) if (ledger.has(hash(`source:${row.source_id}`))) sources.add(row.source_id);
    const scope=erasureScope();
    for (const sourceId of sources) {
      purgeDerived(stagedStore,sourceId,scope);
      db.prepare('UPDATE memories SET supersedes=NULL WHERE supersedes IN(SELECT id FROM memories WHERE source_id=?)').run(sourceId);
      for (const table of ['memories','reviews','retrieval','skills']) db.prepare(`DELETE FROM ${table} WHERE source_id=?`).run(sourceId);
      const attached = db.prepare('SELECT id FROM attachments WHERE source_id=?').all(sourceId) as { id: string }[];
      for (const a of attached) await rm(join(staged,'attachments',a.id),{force:true});
      db.prepare('DELETE FROM attachments WHERE source_id=?').run(sourceId);
      db.prepare('DELETE FROM messages WHERE id=?').run(sourceId); db.prepare('DELETE FROM mail WHERE id=?').run(sourceId);
    }
    for(const doc of stagedStore.all<{id:string;source_id:string|null;kind:string}>('SELECT * FROM documents WHERE deleted_at IS NULL')) {
      const revisions=stagedStore.all<{revision:number;original_hash:string}>('SELECT revision,original_hash FROM document_revisions WHERE document_id=?',doc.id);
      if(ledger.has(hash(`document:${doc.id}`))||doc.source_id&&ledger.has(hash(`source:${doc.source_id}`))||revisions.some(rev=>ledger.has(hash(`source:document:${doc.id}:r${rev.revision}`))||doc.kind==='import'&&ledger.has(hash(`document-content:${rev.original_hash}`))))eraseDocument(stagedStore,doc.id,true,scope);
    }
    // Scoped invalidation: runs whose context reached an erased source lose their derived history.
    // The all-history fallback only runs when ledger entries cannot be matched to a staged source.
    purgeAssistantContext(stagedStore,scope);
    if (ledger.size && !sources.size) db.exec("DELETE FROM messages WHERE role!='user'; UPDATE conversations SET summary=''; DELETE FROM context_checkpoints; DELETE FROM skill_reviews; UPDATE runs SET partial='',status=CASE WHEN status='completed' THEN 'interrupted' ELSE status END,error=CASE WHEN status='completed' THEN 'Derived response erased during restore; prior effects may remain' ELSE error END; UPDATE operations SET result=NULL; UPDATE telegram_updates SET data='{}'; DELETE FROM feedback WHERE notification_id IN(SELECT id FROM outbox WHERE id LIKE 'reply:%' OR id LIKE 'task:%'); DELETE FROM outbox WHERE id LIKE 'reply:%' OR id LIKE 'task:%';");
    else purgeErasedContext(stagedStore,scope);
    for (const row of stagedStore.all<{hash:string}>('SELECT hash FROM deletions')) ledger.add(row.hash);
    for (const deletion of ledger) db.prepare('INSERT OR REPLACE INTO deletions VALUES(?,?)').run(deletion,Date.now());
    // Snapshot-pending work may already have taken effect after backup; never replay it on restore.
    db.exec("UPDATE runs SET status='interrupted',error='Restored incomplete run requires owner review' WHERE status IN ('queued','running'); UPDATE outbox SET status='uncertain',error='Restored unfinished delivery; later acceptance unknown. Explicit owner review required.' WHERE status IN ('pending','paused','sending'); UPDATE occurrences SET status='interrupted',lease_until=NULL,error='Restored unfinished occurrence; later execution unknown. Owner review required.' WHERE status IN ('pending','paused','leased','running');");
    // An old snapshot must never restore a revoked cross-owner capability or replay family work.
    db.exec("UPDATE family_peers SET active=0; DELETE FROM family_shares; UPDATE family_requests SET status='uncertain' WHERE status='running'; UPDATE schedules SET status='cancelled' WHERE id IN(SELECT schedule_id FROM family_reminders); UPDATE outbox SET status='cancelled' WHERE status IN('pending','paused','sending','uncertain') AND occurrence_id IN(SELECT o.id FROM occurrences o JOIN family_reminders f ON f.schedule_id=o.schedule_id); UPDATE occurrences SET status='cancelled',lease_until=NULL WHERE status IN('pending','paused','leased','running','interrupted') AND schedule_id IN(SELECT schedule_id FROM family_reminders);");
    db.prepare("UPDATE schedules SET status='paused' WHERE status='active' AND next_due<=?").run(Date.now());
    cleanupGeneratedImages(stagedStore); cleanupSkills(stagedStore);
    new Skills(stagedStore).restoreDirectories();
    const remainingKnowledge=knowledgeFiles(stagedStore);
    const erasedDocuments=stagedStore.all<{id:string}>('SELECT id FROM documents WHERE deleted_at IS NOT NULL');
    db.close();
    // Preserve a consistent safety snapshot of the current DB before replacing it.
    const current = new Store(root,config); await backup(current); current.close();
    // Hold post-snapshot/manual files for review; they must not be rediscovered as restored capabilities.
    const skillRecovery = join(root, 'skill-recovery', id());
    for (const directory of ['skills', '.agents/skills']) {
      const target = join(root,directory);
      if (existsSync(target)) {
        for (const part of directory.split('/').map((_part,index,parts)=>join(root,...parts.slice(0,index+1)))) if(lstatSync(part).isSymbolicLink())throw new Error('Unsafe skill directory during restore');
        await mkdir(skillRecovery,{recursive:true,mode:0o700});
        await import('node:fs/promises').then(fs=>fs.rename(target,join(skillRecovery,directory.replaceAll('/','-'))));
      }
      if(existsSync(join(staged,directory))){await mkdir(join(root,directory,'..'),{recursive:true,mode:0o700});await import('node:fs/promises').then(fs=>fs.rename(join(staged,directory),target));}
    }
    // Immutable media is copied first; a crash only leaves unreferenced files, never a DB pointing to absent files.
    for (const name of await readdir(join(staged,'attachments'))) await copyFile(join(staged,'attachments',name),join(root,'attachments',name));
    for(const doc of erasedDocuments)await rm(join(root,'knowledge','objects',doc.id),{recursive:true,force:true});
    for(const file of remainingKnowledge){await mkdir(join(root,file.path,'..'),{recursive:true,mode:0o700});await copyFile(join(staged,file.path),join(root,file.path));}
    for(const name of ['qmd.sqlite','qmd.sqlite-wal','qmd.sqlite-shm'])await rm(join(root,'knowledge',name),{force:true});
    await rm(join(root,'knowledge','searchable'),{recursive:true,force:true});
    for (const suffix of ['-wal','-shm']) await rm(join(root,`pikobot.sqlite${suffix}`),{force:true});
    await import('node:fs/promises').then(fs => fs.rename(join(staged,'pikobot.sqlite'),join(root,'pikobot.sqlite')));
    if (ledger.size) atomicWrite(join(root,'deletion-ledger.json'),json([...ledger]));
  } finally { await rm(staged,{recursive:true,force:true}); unlock(); }
}
