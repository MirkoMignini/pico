import { existsSync, mkdirSync, readdirSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { Store, id, hash, json } from './store.js';
import type { Envelope } from './contracts.js';
import { directoryPackage, encodedFiles, packageFromFiles, skillName, skillPath, type SkillPackage, type PackageFile } from './skill-package.js';

interface SkillRow { id: string; version: number; name: string; scope: string; instructions: string; source_id: string; status: string; created_at: number; description?: string; content_hash?: string; metadata?: string; directory?: string; origin?: string }
const columns = 's.*,p.description,p.content_hash,p.metadata,p.directory,p.origin';
const tables = 'skills s LEFT JOIN skill_packages p ON p.skill_id=s.id AND p.version=s.version';
export const skillSourceId = (skillId: string, version: number) => `skill:${skillId}:${version}`;
function safeDirectory(root: string, relative: string): string {
  if (!/^(?:skills|\.agents\/skills)\/[^/]+$/u.test(relative)) throw new Error('Invalid skill storage directory');
  skillName(basename(relative));
  const path = join(root, relative);
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = join(current, part); mkdirSync(current, { recursive: true, mode: 0o700 });
    const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill directory cannot be a symlink');
  }
  return path;
}
export function eraseSkillVersion(store: Store, skillId: string, version: number): void {
  const row = store.get<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.id=? AND s.version=?`, skillId, version);
  if (!row) return;
  store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)', hash(`source:${skillSourceId(skillId, version)}`), Date.now());
  if (row.content_hash) store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)', hash(`skill-content:${row.content_hash}`), Date.now());
  store.run('DELETE FROM skills WHERE id=? AND version=?', skillId, version);
  if (row.directory && !store.get(`SELECT s.id FROM ${tables} WHERE p.directory=? AND s.status='active'`, row.directory)) {
    store.run('INSERT OR REPLACE INTO deletions VALUES(?,?)', hash(`skill-name:${row.name}`), Date.now());
    store.setMeta(`skills.erase:${hash(row.directory)}`, json({ directory: row.directory }));
  }
}
export function cleanupSkills(store: Store): void {
  for (const entry of store.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'skills.erase:%'")) {
    const { directory } = JSON.parse(entry.value) as { directory: string };
    const target = safeDirectory(store.root, directory);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    store.run('DELETE FROM meta WHERE key=?', entry.key);
  }
  for (const entry of store.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'skills.output-unlink:%'")) {
    if (!/^[a-zA-Z0-9-]+$/.test(entry.value)) throw new Error('Invalid skill output cleanup identity');
    rmSync(join(store.root, 'attachments', entry.value), { force: true }); store.run('DELETE FROM meta WHERE key=?', entry.key);
  }
}
export function retainedSkillSource(store: Store, sourceId: string) {
  const match = /^skill:([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(sourceId);
  if (!match) return;
  const row = store.get<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.id=? AND s.version=?`, match[1]!, Number(match[2]));
  return row ? { id: sourceId, text: row.instructions, actor: row.origin === 'directory' || row.origin === 'imported' ? 'external:skill-package' : `assistant:${store.config.instanceId}`, event_at: row.created_at, recorded_at: row.created_at } : undefined;
}

export class Skills {
  readonly errors = new Map<string, string>();
  private volatile = new Map<string, Map<string, number>>();
  private syncing = false;
  private running = new Map<string, Set<AbortController>>();
  trackRun(skillId: string, controller: AbortController): () => void {
    const runs = this.running.get(skillId) ?? new Set<AbortController>(); runs.add(controller); this.running.set(skillId, runs);
    return () => { runs.delete(controller); if (!runs.size) this.running.delete(skillId); };
  }
  private cancelRuns(skillId: string): void {
    for (const controller of this.running.get(skillId) ?? []) controller.abort(new Error('Skill changed or disabled; accepted effects may remain'));
    this.store.run('DELETE FROM skill_activations WHERE skill_id=?', skillId);
    for (const selected of this.volatile.values()) selected.delete(skillId);
  }
  async stopRuns(): Promise<void> {
    for (const skillId of this.running.keys()) this.cancelRuns(skillId);
    while (this.running.size) await new Promise(resolve => setTimeout(resolve, 10));
  }
  constructor(readonly store: Store, private ownerEvidence?: (text: string) => string) {}
  private row(name: string, active = true): SkillRow | undefined {
    return this.store.get<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.name=? ${active ? "AND s.status='active'" : ''} ORDER BY (p.content_hash IS NOT NULL) DESC,s.version DESC LIMIT 1`, name);
  }
  private assertOwner(context: Envelope): void {
    if (context.ownerId !== this.store.config.ownerId || context.instanceId !== this.store.config.instanceId) throw new Error('Skill ownership mismatch');
  }
  assertWrite(context: Envelope): void {
    this.assertOwner(context);
    if (!context.source.trustedOwner || context.mode !== 'foreground') throw new Error('Skills require trusted retained owner foreground work for writes or execution');
  }
  private track(row: SkillRow, context: Envelope): void {
    this.assertOwner(context);
    if (row.scope !== 'global' && row.scope !== context.source.channel) throw new Error('Skill is outside this channel scope');
    if (context.mode === 'ephemeral' || !context.runId) return;
    this.store.linkSource(context.runId, skillSourceId(row.id, row.version));
    this.store.linkSource(context.runId, row.source_id);
    for (const source of this.store.all<{ source_id: string }>('SELECT source_id FROM skill_sources WHERE skill_id=? AND version=? UNION SELECT s.source_id FROM skill_derivations d JOIN run_sources s ON s.run_id=d.run_id WHERE d.skill_id=? AND d.version=?', row.id, row.version, row.id, row.version)) this.store.linkSource(context.runId, source.source_id);
  }
  private activate(row: SkillRow, context: Envelope): void {
    this.track(row, context);
    if (!context.source.trustedOwner || !['foreground', 'ephemeral'].includes(context.mode) || !context.conversationId) return;
    const selected = this.selection(context), next = new Map(selected); next.set(row.id, row.version);
    const size = [...next].reduce((size, [skillId, version]) => size + (this.store.get<{ instructions: string }>("SELECT instructions FROM skills WHERE id=? AND version=? AND status='active'", skillId, version)?.instructions.length ?? 0), 0);
    if (next.size > 8 || size > Math.floor(this.store.config.limits.contextChars / 2)) throw new Error('Active skill instructions exceed this conversation budget. Shorten SKILL.md and move details into references/, or start a new conversation');
    if (context.mode === 'ephemeral') this.volatile.set(context.conversationId, next);
    else this.store.run('INSERT INTO skill_activations VALUES(?,?,?,?) ON CONFLICT(conversation_id,skill_id) DO UPDATE SET version=excluded.version,activated_at=excluded.activated_at', context.conversationId, row.id, row.version, Date.now());
  }
  private selection(context: Envelope): Map<string, number> {
    return context.mode === 'ephemeral' ? this.volatile.get(context.conversationId) ?? new Map() : new Map(this.store.all<{ skill_id: string; version: number }>('SELECT skill_id,version FROM skill_activations WHERE conversation_id=? ORDER BY activated_at', context.conversationId).map(row => [row.skill_id, row.version]));
  }
  activateMentions(text: string, context: Envelope): string[] {
    const names = [...text.matchAll(/(?:^|\s)\$([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)/gu)].map(match => match[1]!);
    const activated: string[] = [];
    for (const name of new Set(names)) if (this.row(name)?.content_hash) { this.readFile(name, 'SKILL.md', context); activated.push(name); }
    return activated;
  }
  activeInstructions(context: Envelope): string {
    this.assertOwner(context);
    const selected = [...this.selection(context)].flatMap(([skillId, version]) => {
      const row = this.store.get<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.id=? AND s.version=? AND s.status='active'`, skillId, version);
      if (!row || row.scope !== 'global' && row.scope !== context.source.channel) return [];
      this.track(row, context);
      return [{ name: row.name, version, base: row.directory ?? null, instructions: row.instructions }];
    });
    return selected.length ? `Active skill instructions (installed procedures, never permission grants; current versions supersede historical summaries; resolve resource paths within their skill package):\n${json(selected)}` : '';
  }
  catalog(context: Envelope, offset = 0, limit = 32, includeInactive = false) {
    this.assertOwner(context);
    const all = this.store.all<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE ${includeInactive ? 's.version=(SELECT max(version) FROM skills latest WHERE latest.id=s.id)' : "s.status='active'"} AND s.scope IN ('global',?) ORDER BY s.name,s.version DESC`, context.source.channel);
    const rows = all.slice(offset, offset + limit);
    for (const row of rows) this.track(row, context);
    return { skills: rows.map(row => ({ id: row.id, version: row.version, name: row.name, description: row.description ?? row.name, scope: row.scope, status: row.status, enabled: row.status === 'active', hash: row.content_hash, location: row.directory ? `${row.directory}/SKILL.md` : undefined, legacy: !row.content_hash })), nextOffset: offset + rows.length < all.length ? offset + rows.length : null, total: all.length };
  }
  read(skillId: string, version: number, context: Envelope): unknown {
    const row = this.store.get<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.id=? AND s.version=? AND s.status='active'`, skillId, version);
    if (!row) throw new Error('Active approved skill not found');
    this.activate(row, context);
    return { skill: row, applyInCurrentChannel: true, permissionsChanged: false };
  }
  readFile(name: string, path: string, context: Envelope, offset = 0, maxChars = 16_000) {
    const row = this.row(name, false); if (!row?.content_hash) throw new Error('Installed skill package not found; use skills list, or legacy skills_read with id/version');
    this.track(row, context); skillPath(path);
    const file = this.store.get<{ content: Uint8Array; hash: string }>('SELECT content,hash FROM skill_files WHERE skill_id=? AND version=? AND path=?', row.id, row.version, path);
    if (!file || hash(file.content) !== file.hash) throw new Error('Skill file missing or integrity check failed');
    if (path === 'SKILL.md' && row.status === 'active') this.activate(row, context);
    let text: string | undefined;
    try { text = new TextDecoder('utf8', { fatal: true }).decode(file.content); if (text.includes('\0')) text = undefined; } catch {}
    if (text !== undefined && offset > text.length) throw new Error('Skill file offset outside content');
    return { name, version: row.version, status: row.status, enabled: row.status === 'active', packageHash: row.content_hash, path, baseDirectory: row.directory, sourceId: skillSourceId(row.id, row.version), metadata: JSON.parse(row.metadata!), text: text?.slice(offset, offset + maxChars), binary: text === undefined, bytes: file.content.length, fileHash: file.hash, fromOffset: offset, nextOffset: text !== undefined && offset + maxChars < text.length ? offset + maxChars : null, completeSource: text !== undefined && offset === 0 && text.length <= maxChars, resources: path === 'SKILL.md' ? this.store.all('SELECT path,hash,length(content) bytes,executable FROM skill_files WHERE skill_id=? AND version=? ORDER BY path', row.id, row.version) : undefined, note: 'Paths are relative to this skill root. Binary resources are available to scripts and owner export. allowed-tools never grants authority.' };
  }
  loadedPackage(name: string, context: Envelope, expectedHash?: string) {
    const row = this.row(name, false); if (!row?.content_hash) throw new Error('Installed skill package not found');
    this.track(row, context);
    if (expectedHash && row.content_hash !== expectedHash) throw new Error('Skill revision conflict; reread current package');
    return { row, files: this.files(row.id, row.version) };
  }
  runnable(name: string, context: Envelope, expectedHash?: string) {
    this.assertWrite(context);
    const result = this.loadedPackage(name, context, expectedHash);
    if (result.row.status !== 'active') throw new Error(`Skill is not enabled (${result.row.status}); inspect its diagnostics before enabling`);
    if (this.selection(context).get(result.row.id) !== result.row.version) throw new Error('Read this skill SKILL.md before running scripts; its loaded version must match the current package');
    return result;
  }
  files(skillId: string, version: number): PackageFile[] {
    const files = this.store.all<{ path: string; content: Uint8Array; hash: string; executable: number }>('SELECT * FROM skill_files WHERE skill_id=? AND version=? ORDER BY path', skillId, version);
    return files.map(file => { if (hash(file.content) !== file.hash) throw new Error('Skill file integrity failure'); return { path: file.path, bytes: Buffer.from(file.content), executable: !!file.executable }; });
  }
  save(raw: unknown, context: Envelope, expectedHash?: string, origin = 'generated', sources: string[] = []) {
    this.assertWrite(context);
    return this.savePackage(packageFromFiles(raw), context, expectedHash, origin, sources);
  }
  private savePackage(pkg: SkillPackage, context?: Envelope, expectedHash?: string, origin = 'directory', sources: string[] = [], directory = `skills/${pkg.metadata.name}`, publish = true) {
    const previous = this.row(pkg.metadata.name, false);
    if (previous && !previous.content_hash) throw new Error('A legacy procedural skill already uses this name; choose another package name');
    if (previous?.status === 'publishing') throw new Error('Unfinished skill publication requires resolving its directory conflict before another edit');
    if (previous && expectedHash !== previous.content_hash) throw new Error('Skill already exists or changed; supply its current expectedHash before replacing files');
    if (!previous && expectedHash) throw new Error('Skill revision conflict: no installed package');
    if (previous?.content_hash === pkg.hash && ['active', 'disabled'].includes(previous.status)) return { name: previous.name, id: previous.id, version: previous.version, hash: pkg.hash, saved: true, unchanged: true, enabled: previous.status === 'active' };
    const skillId = previous?.id ?? id(), version = (previous?.version ?? 0) + 1;
    const input = context && this.store.get<{ id: string }>("SELECT id FROM messages WHERE run_id=? AND role='user' ORDER BY rowid LIMIT 1", context.runId);
    const source = input?.id ?? skillSourceId(skillId, version), desired = previous?.status === 'disabled' ? 'disabled' : 'active';
    this.store.transaction(() => {
      for (const source of sources) if (this.store.get('SELECT hash FROM deletions WHERE hash=?', hash(`source:${source}`))) throw new Error('Skill input source was forgotten');
      if (context) this.store.run('DELETE FROM deletions WHERE hash IN(?,?)', hash(`skill-name:${pkg.metadata.name}`), hash(`skill-content:${pkg.hash}`));
      this.store.run('INSERT INTO skills VALUES(?,?,?,?,?,?,?,?)', skillId, version, pkg.metadata.name, 'global', pkg.instructions, source, publish ? 'publishing' : desired, Date.now());
      this.store.run('INSERT INTO skill_packages(skill_id,version,description,metadata,content_hash,directory,origin) VALUES(?,?,?,?,?,?,?)', skillId, version, pkg.metadata.description, json(pkg.metadata), pkg.hash, directory, origin);
      for (const file of pkg.files) this.store.run('INSERT INTO skill_files VALUES(?,?,?,?,?,?)', skillId, version, file.path, hash(file.bytes), file.bytes, Number(file.executable));
      const dependencies = new Set([source, ...sources, ...(context ? this.store.all<{ source_id: string }>('SELECT source_id FROM run_sources WHERE run_id=?', context.runId).map(row => row.source_id) : []), ...(previous ? this.store.all<{ source_id: string }>('SELECT source_id FROM skill_sources WHERE skill_id=? AND version=?', previous.id, previous.version).map(row => row.source_id) : [])]);
      for (const dependency of dependencies) this.store.run('INSERT OR IGNORE INTO skill_sources VALUES(?,?,?)', skillId, version, dependency);
      if (context) this.store.run('INSERT INTO skill_derivations VALUES(?,?,?)', skillId, version, context.runId);
      if (publish) this.store.setMeta(`skills.publish:${skillId}`, json({ skillId, version, directory, previousHash: previous?.content_hash ?? null, desired }));
      else this.store.run("UPDATE skills SET status='superseded' WHERE id=? AND version!=? AND status IN ('active','disabled','invalid','missing')", skillId, version);
      this.store.audit('skill.install', origin, context?.runId);
    });
    this.cancelRuns(skillId);
    if (publish) this.publish(`skills.publish:${skillId}`);
    return { name: pkg.metadata.name, id: skillId, version, hash: pkg.hash, saved: true, enabled: desired === 'active', location: `${directory}/SKILL.md`, files: pkg.files.map(file => ({ path: file.path, bytes: file.bytes.length })), warnings: pkg.warnings, testsRun: false };
  }
  private publish(key: string): void {
    const pending = this.store.meta(key); if (!pending) return;
    const { skillId, version, directory, previousHash, desired } = JSON.parse(pending) as { skillId: string; version: number; directory: string; previousHash: string | null; desired: string };
    const row = this.store.get<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.id=? AND s.version=? AND s.status='publishing'`, skillId, version);
    if (!row) { this.store.run('DELETE FROM meta WHERE key=?', key); return; }
    const target = safeDirectory(this.store.root, directory), stage = join(dirname(target), `.pico-stage-${skillId}`), old = join(dirname(target), `.pico-old-${skillId}`);
    if (existsSync(target)) {
      const current = directoryPackage(target);
      if (current.hash !== row.content_hash && current.hash !== previousHash) throw new Error('Skill publication conflict: directory changed. Existing files were not overwritten');
      if (current.hash === row.content_hash) { this.finishPublication(key, row, desired); rmSync(old, { recursive: true, force: true }); return; }
    }
    rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { mode: 0o700 });
    for (const file of this.files(skillId, version)) { const path = join(stage, skillPath(file.path)); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, file.bytes, { mode: file.executable ? 0o700 : 0o600, flag: 'wx' }); }
    if (existsSync(target)) { rmSync(old, { recursive: true, force: true }); renameSync(target, old); }
    renameSync(stage, target);
    this.finishPublication(key, row, desired); rmSync(old, { recursive: true, force: true });
  }
  private finishPublication(key: string, row: SkillRow, desired: string): void {
    this.store.transaction(() => { this.store.run("UPDATE skills SET status='superseded' WHERE id=? AND version!=? AND status IN ('active','disabled','invalid','missing')", row.id, row.version); this.store.run('UPDATE skills SET status=? WHERE id=? AND version=?', desired, row.id, row.version); this.store.run('DELETE FROM meta WHERE key=?', key); });
  }
  sync(): void {
    if (this.syncing) return; this.syncing = true;
    try {
      cleanupSkills(this.store); this.errors.clear();
      for (const row of this.store.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'skills.publish:%'")) try { this.publish(row.key); } catch (error) { this.errors.set(row.key, error instanceof Error ? error.message : 'Skill publication failed'); }
      const seen = new Set<string>(); let count = 0;
      for (const root of ['skills', '.agents/skills']) {
        const directory = join(this.store.root, root);
        if (!existsSync(directory)) continue;
        if (root.split('/').some((_part, index, parts) => lstatSync(join(this.store.root, ...parts.slice(0, index + 1))).isSymbolicLink()) || !lstatSync(directory).isDirectory()) { this.errors.set(root, 'Skill search root must be a real directory, not a symlink'); continue; }
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (++count > 200) { this.errors.set(root, 'Skill discovery limited to 200 directories; remove unused packages'); break; }
          const relative = `${root}/${entry.name}`;
          try {
            const name = skillName(entry.name);
            if (seen.has(name)) { this.errors.set(relative, 'Shadowed by a skill in the higher-priority skills/ directory'); continue; }
            seen.add(name);
            if (this.store.get('SELECT hash FROM deletions WHERE hash=?', hash(`skill-name:${name}`))) { this.errors.set(relative, 'Forgotten skill is held inactive; explicitly import it to reinstall'); continue; }
            const pkg = directoryPackage(join(directory, entry.name)), previous = this.row(pkg.metadata.name, false);
            if (this.store.get('SELECT hash FROM deletions WHERE hash=?', hash(`skill-content:${pkg.hash}`))) throw new Error('Previously forgotten skill content cannot be rediscovered automatically');
            if (previous?.status === 'publishing') continue;
            if (previous?.content_hash === pkg.hash) {
              this.store.run('UPDATE skill_packages SET directory=? WHERE skill_id=? AND version=?', relative, previous.id, previous.version);
              if (['invalid', 'missing'].includes(previous.status)) this.store.run("UPDATE skills SET status='active' WHERE id=? AND version=?", previous.id, previous.version);
              continue;
            }
            this.savePackage(pkg, undefined, previous?.content_hash, 'directory', [], relative, false);
          } catch (error) {
            this.errors.set(relative, error instanceof Error ? error.message : 'Invalid skill directory');
            for (const row of this.store.all<{ skill_id: string }>('SELECT DISTINCT p.skill_id FROM skill_packages p JOIN skills s ON s.id=p.skill_id AND s.version=p.version WHERE p.directory=? OR s.name=?', relative, entry.name.normalize('NFKC'))) {
              this.cancelRuns(row.skill_id); this.store.run("UPDATE skills SET status='invalid' WHERE status='active' AND id=?", row.skill_id);
            }
          }
        }
      }
      for (const row of this.store.all<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.status='active' AND p.directory IS NOT NULL`)) if (!seen.has(row.name)) { this.cancelRuns(row.id); this.store.run("UPDATE skills SET status='missing' WHERE id=? AND version=?", row.id, row.version); }
    } finally { this.syncing = false; }
  }
  control(name: string, action: 'enable' | 'disable' | 'rollback', context: Envelope, version?: number) {
    this.assertWrite(context);
    const previous = this.row(name, false); if (!previous?.content_hash) throw new Error('Skill package not found');
    if (action === 'rollback') {
      const target = this.store.get<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE s.id=? AND s.version=?`, previous.id, version ?? 0);
      if (!target?.content_hash) throw new Error('Skill version not found');
      return this.save(encodedFiles(this.files(target.id, target.version)), context, previous.content_hash, 'rollback');
    }
    if (action === 'enable') {
      const current = directoryPackage(safeDirectory(this.store.root, previous.directory!));
      if (current.hash !== previous.content_hash) throw new Error('Skill directory changed; refresh and review it before enabling');
    }
    this.cancelRuns(previous.id);
    this.store.transaction(() => { this.store.run("UPDATE skills SET status='superseded' WHERE id=? AND status='active'", previous.id); this.store.run('UPDATE skills SET status=? WHERE id=? AND version=?', action === 'enable' ? 'active' : 'disabled', previous.id, previous.version); });
    return { name, version: previous.version, enabled: action === 'enable', hash: previous.content_hash };
  }
  validateStorage(): void {
    for (const row of this.store.all<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE p.skill_id IS NOT NULL`)) {
      if (!/^[a-f0-9-]{36}$/.test(row.id) || !Number.isSafeInteger(row.version) || row.version < 1 || !/^(?:skills|\.agents\/skills)\/[^/]+$/u.test(row.directory ?? '')) throw new Error('Invalid skill identity or directory in snapshot');
      const pkg = packageFromFiles(encodedFiles(this.files(row.id, row.version)));
      if (pkg.hash !== row.content_hash || pkg.metadata.name !== row.name || pkg.instructions !== row.instructions || json(pkg.metadata) !== row.metadata) throw new Error('Skill package integrity failure in snapshot');
    }
  }
  restoreDirectories(): void {
    this.validateStorage();
    for (const row of this.store.all<SkillRow>(`SELECT ${columns} FROM ${tables} WHERE p.skill_id IS NOT NULL AND s.status IN ('active','disabled') AND s.version=(SELECT max(version) FROM skills latest WHERE latest.id=s.id)`)) {
      const desired = row.status;
      this.store.transaction(() => { this.store.run("UPDATE skills SET status='publishing' WHERE id=? AND version=?", row.id, row.version); this.store.setMeta(`skills.publish:${row.id}`, json({ skillId: row.id, version: row.version, directory: row.directory, previousHash: row.content_hash, desired })); });
    }
    this.sync();
    if (this.errors.size) throw new Error('Skill directory reconstruction failed: ' + [...this.errors.values()].join('; '));
  }
  learn(name: string, instructions: string, scope = 'global'): unknown {
    if (!instructions.trim() || instructions.length > 12_000) throw new Error('Skill instructions invalid');
    if (!this.ownerEvidence) throw new Error('Explicit owner evidence service required');
    return this.store.transaction(() => {
      const existing = this.store.get<{ id: string; version: number }>('SELECT id,max(version) AS version FROM skills WHERE name=? AND scope=?', name, scope);
      if (this.store.get('SELECT s.id FROM skills s JOIN skill_packages p ON p.skill_id=s.id AND p.version=s.version WHERE s.name=?', name)) throw new Error('Use package save to update a file-based skill');
      const skillId = existing?.id ?? id(), version = (existing?.version ?? 0) + 1;
      const sourceId = this.ownerEvidence!(`Explicit learned procedure ${name}: ${instructions}`);
      this.store.run("UPDATE skills SET status='superseded' WHERE id=?", skillId); this.store.run('INSERT INTO skills VALUES(?,?,?,?,?,?,?,?)', skillId, version, name, scope, instructions, sourceId, 'active', Date.now());
      return { id: skillId, version, scope, retained: true, note: 'Instructions only; no permissions changed' };
    });
  }
  approve(skillId: string, version: number, digest: string): unknown {
    return this.store.transaction(() => {
      if (this.store.get('SELECT skill_id FROM skill_packages WHERE skill_id=?', skillId)) throw new Error('File skills are updated through package revision checks, not procedural approval');
      const skill = this.store.get<{ instructions: string }>("SELECT instructions FROM skills WHERE id=? AND version=? AND status='candidate'", skillId, version);
      if (!skill || hash(skill.instructions) !== digest) throw new Error('Skill changed or is not a candidate');
      this.store.run("UPDATE skills SET status='superseded' WHERE id=? AND status='active'", skillId); this.store.run("UPDATE skills SET status='active' WHERE id=? AND version=?", skillId, version);
      return { id: skillId, version, note: 'Instructions activated; no permissions changed' };
    });
  }
  rollback(skillId: string, version: number): void {
    if (this.store.get('SELECT skill_id FROM skill_packages WHERE skill_id=?', skillId)) throw new Error('Use skills rollback by package name');
    if (!this.store.get('SELECT id FROM skills WHERE id=? AND version=?', skillId, version)) throw new Error('Skill version not found');
    this.store.transaction(() => { this.store.run("UPDATE skills SET status='superseded' WHERE id=?", skillId); this.store.run("UPDATE skills SET status='active' WHERE id=? AND version=?", skillId, version); });
  }
  clearVolatile(): void { this.volatile.clear(); }
}
