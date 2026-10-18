import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { secureFile } from './config.js';
import type { Config } from './contracts.js';
import { SCHEMA_VERSION } from './version.js';

export const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const id = (): string => randomUUID();
export const json = (value: unknown): string => JSON.stringify(value);
export function textChunks(text: string, size = 1200, overlap = 160): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (boundary > start + size / 2) end = boundary;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    const chunk = text.slice(start, end);
    if (chunk.trim()) chunks.push(chunk);
    if (end === text.length) break;
    start = end - overlap;
    if (/[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  }
  return chunks;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly root: string, readonly config: Config) {
    const file = join(root, 'pico.sqlite');
    this.db = new DatabaseSync(file);
    secureFile(file);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    const version = this.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
    if (version > SCHEMA_VERSION) throw new Error('Database newer than application; restore the matching build');
    if (version === 0) this.transaction(() => {
      this.db.exec(readFileSync(new URL('../migrations/001.sql', import.meta.url), 'utf8'));
      this.run('INSERT INTO meta VALUES(?,?)', 'ownerId', config.ownerId);
      this.run('INSERT INTO meta VALUES(?,?)', 'instanceId', config.instanceId);
      this.db.exec('PRAGMA user_version=1');
    });
    if (this.meta('ownerId') !== config.ownerId || this.meta('instanceId') !== config.instanceId) { this.db.close(); throw new Error('Database ownership does not match this instance'); }
    if (version < 2) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/002.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=2'); });
    if(version<3)this.transaction(()=>{this.db.exec(readFileSync(new URL('../migrations/003.sql',import.meta.url),'utf8'));this.db.exec('PRAGMA user_version=3');});
    if(version<4)this.transaction(()=>{this.db.exec(readFileSync(new URL('../migrations/004.sql',import.meta.url),'utf8'));this.db.exec('PRAGMA user_version=4');});
    if (version < 5) this.transaction(() => {
      this.db.exec(readFileSync(new URL('../migrations/005.sql', import.meta.url), 'utf8'));
      for (const row of this.all<{id:string;kind:string;text:string;source_id:string;event_at:number;entity:string|null}>('SELECT * FROM retrieval')) {
        this.index({ id: row.id, kind: row.kind, text: row.text, sourceId: row.source_id, eventAt: row.event_at, entity: row.entity ?? undefined });
      }
      this.db.exec('PRAGMA user_version=5');
    });
    if (version < 6) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/006.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=6'); });
    if (version < 7) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/007.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=7'); });
    if (version < 8) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/008.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=8'); });
    if (version < 9) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/009.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=9'); });
    if (version < 10) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/010.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=10'); });
    if (version < 11) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/011.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=11'); });
    if (version < 12) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/012.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=12'); });
    if (version < 13) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/013.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=13'); });
    if (version < 14) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/014.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=14'); });
    if (version < 15) this.transaction(() => { this.db.exec(readFileSync(new URL('../migrations/015.sql', import.meta.url), 'utf8')); this.db.exec('PRAGMA user_version=15'); });
    this.db.exec("INSERT INTO retrieval_fts(retrieval_fts,rank) VALUES('secure-delete',1)");
  }
  run(sql: string, ...args: SQLInputValue[]): number { return Number(this.db.prepare(sql).run(...args).changes); }
  // Evidence lineage: direct use by this run always wins over context inherited from earlier runs.
  linkSource(runId: string, sourceId: string, inherited = false): void {
    this.run('INSERT INTO run_sources(run_id,source_id,inherited) VALUES(?,?,?) ON CONFLICT(run_id,source_id) DO UPDATE SET inherited=MIN(run_sources.inherited,excluded.inherited)', runId, sourceId, inherited ? 1 : 0);
  }
  get<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  transaction<T>(fn: () => T): T {
    const savepoint=this.db.isTransaction?`nested_${id().replaceAll('-','')}`:undefined;
    this.db.exec(savepoint?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
    try { const value=fn();this.db.exec(savepoint?`RELEASE ${savepoint}`:'COMMIT');return value; }
    catch(error){this.db.exec(savepoint?`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`:'ROLLBACK');throw error;}
  }
  meta(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM meta WHERE key=?', key)?.value; }
  setMeta(key: string, value: string): void { this.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  audit(operation: string, status: string, runId?: string): void { this.run('INSERT INTO audit(run_id,operation,status,at) VALUES(?,?,?,?)', runId ?? null, operation, status, Date.now()); }
  index(record: { id: string; kind: string; text: string; sourceId: string; eventAt: number; entity?: string }): void {
    this.transaction(() => {
      const prefix = `${record.id}:chunk:`;
      this.run('DELETE FROM retrieval WHERE id=? OR substr(id,1,length(?))=?', record.id, prefix, prefix);
      const chunks = record.kind === 'memory' ? [record.text] : textChunks(record.text);
      chunks.forEach((text, index) => this.run('INSERT INTO retrieval VALUES(?,?,?,?,?,?)', index ? `${prefix}${index}` : record.id, record.kind, text, record.sourceId, record.eventAt, record.entity ?? null));
    });
  }
  close(): void { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
export function acquireLock(root: string): () => void {
  const path = join(root, 'authority.sqlite');
  const lock = new DatabaseSync(path);
  secureFile(path);
  try {
    lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
  } catch { lock.close(); throw new Error('Authoritative daemon already owns this instance'); }
  // SQLite's OS-backed lock is released by the kernel even after SIGKILL.
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}
