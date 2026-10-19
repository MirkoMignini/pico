import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseDocument } from 'yaml';
import AdmZip from 'adm-zip';
import { Type } from 'typebox';
import { object, validate } from './contracts.js';
import { hash, json } from './store.js';

export const SKILL_BYTES = 10_000_000;
export const SKILL_FILE_BYTES = 4_000_000;
export const SKILL_FILES = 256;
export const SkillNameSchema = Type.String({ minLength: 1, maxLength: 128 });
export const SkillFileSchema = object({ path: Type.String({ minLength: 1, maxLength: 500 }), content: Type.String({ maxLength: 5_400_000 }), encoding: Type.Optional(Type.Union([Type.Literal('utf8'), Type.Literal('base64')])), executable: Type.Optional(Type.Boolean()) });
export const SkillFilesSchema = Type.Array(SkillFileSchema, { minItems: 1, maxItems: SKILL_FILES });
export interface SkillFile { path: string; content: string; encoding?: 'utf8' | 'base64'; executable?: boolean }
export interface PackageFile { path: string; bytes: Buffer; executable: boolean }
export interface SkillMetadata { name: string; description: string; license?: string; compatibility?: string; metadata?: Record<string, string>; 'allowed-tools'?: string }
export interface SkillPackage { metadata: SkillMetadata; instructions: string; files: PackageFile[]; hash: string; warnings: string[] }
const decoder = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });

export const credentialFile = (path: string): boolean => /^(?:secrets\.json|credentials\.json|auth\.json|ipc\.token|\.env(?:\..*)?|id_rsa|id_ed25519)$/i.test(basename(path));

export function skillName(name: string): string {
  const normalized = name.normalize('NFKC');
  if ([...normalized].length > 64 || normalized !== normalized.toLowerCase() || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(normalized)) throw new Error('Skill name must be 1–64 normalized lowercase letters/numbers separated by single hyphens');
  return normalized;
}
export function skillPath(path: string): string {
  if (!path || path.length > 500 || /[\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(path) || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || path.split('/').length > 16) throw new Error('Skill file path must be a relative path inside the package, without traversal, links or control characters');
  return path;
}
export function parseSkill(text: string, directory?: string): { metadata: SkillMetadata; instructions: string; warnings: string[] } {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter between --- delimiters');
  const document = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core', customTags: [] });
  if (document.errors.length || document.warnings.length) throw new Error('Invalid SKILL.md YAML: ' + [...document.errors, ...document.warnings].map(error => error.message.split('\n')[0]).join('; '));
  let raw: unknown;
  try { raw = document.toJS({ maxAliasCount: 0 }); } catch { throw new Error('YAML aliases are not supported in skill metadata'); }
  const metadata = validate<SkillMetadata>(object({ name: SkillNameSchema, description: Type.String({ minLength: 1, maxLength: 1024 }), license: Type.Optional(Type.String()), compatibility: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), metadata: Type.Optional(Type.Record(Type.String(), Type.String())), 'allowed-tools': Type.Optional(Type.String()) }), raw);
  metadata.name = skillName(metadata.name);
  if (!metadata.description.trim()) throw new Error('Skill description must not be empty');
  if (directory !== undefined && basename(directory).normalize('NFKC') !== metadata.name) throw new Error('Skill directory name must match the name in SKILL.md');
  const warnings: string[] = [];
  if (text.split('\n').length > 500) warnings.push('SKILL.md exceeds the recommended 500 lines; move details into references/');
  if (metadata['allowed-tools']) warnings.push('allowed-tools is advisory metadata, never a permission grant or a bypass of Pikobot execution policy');
  return { metadata, instructions: match[2]!.trim(), warnings };
}
export function packageFromFiles(raw: unknown, directory?: string): SkillPackage {
  const input = validate<SkillFile[]>(SkillFilesSchema, raw), files: PackageFile[] = [], seen = new Set<string>();
  let total = 0;
  for (const file of input) {
    const path = skillPath(file.path), key = path.normalize('NFKC').toLowerCase();
    if (credentialFile(path)) throw new Error('Credential filenames cannot become skill resources');
    if (seen.has(key)) throw new Error('Duplicate or case-colliding skill file path');
    seen.add(key);
    if (file.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))) throw new Error('Invalid base64 skill file');
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    total += bytes.length;
    if (bytes.length > SKILL_FILE_BYTES || total > SKILL_BYTES) throw new Error('Skill package exceeds file or total byte limit');
    files.push({ path, bytes, executable: file.executable === true });
  }
  for (const path of seen) if ([...seen].some(other => other.startsWith(path + '/'))) throw new Error('Skill file/directory path collision');
  const main = files.find(file => file.path === 'SKILL.md');
  if (!main || main.bytes.length > 128_000) throw new Error('A skill needs SKILL.md (at most 128 KB)');
  const parsed = parseSkill(decoder.decode(main.bytes), directory);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { ...parsed, files, hash: hash(json(files.map(file => ({ path: file.path, hash: hash(file.bytes), executable: file.executable })))) };
}
export function encodedFiles(files: PackageFile[]): SkillFile[] {
  return files.map(file => {
    let content: string;
    try { content = decoder.decode(file.bytes); if (content.includes('\0')) throw new Error('binary'); }
    catch { return { path: file.path, content: file.bytes.toString('base64'), encoding: 'base64' as const, executable: file.executable }; }
    return { path: file.path, content, encoding: 'utf8' as const, executable: file.executable };
  });
}
export function readRegular(path: string, limit = SKILL_FILE_BYTES): Buffer {
  if (credentialFile(path)) throw new Error('Credential files cannot become skill resources');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error('Skill inputs must be bounded regular files, not links or special files');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size > limit) throw new Error('Skill file changed while reading');
    const content = readFileSync(fd);
    if (content.length > limit) throw new Error('Skill file exceeds byte limit');
    return content;
  } finally { closeSync(fd); }
}
export function directoryPackage(directory: string): SkillPackage {
  const files: PackageFile[] = []; let directories = 0, total = 0;
  const scan = (path: string, prefix: string, depth: number) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || depth > 12 || ++directories > 2048) throw new Error('Unsafe or excessive skill directory tree');
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules', '__pycache__', '.venv', '.DS_Store'].includes(entry.name)) continue;
      const relative = skillPath(prefix + entry.name), target = join(path, entry.name);
      if (entry.isDirectory()) scan(target, relative + '/', depth + 1);
      else {
        const bytes = readRegular(target); total += bytes.length;
        if (total > SKILL_BYTES || files.length >= SKILL_FILES) throw new Error('Skill package exceeds file/count limits');
        files.push({ path: relative, bytes, executable: !!(lstatSync(target).mode & 0o111) });
      }
    }
  };
  scan(directory, '', 0);
  return packageFromFiles(encodedFiles(files), directory);
}
export function archivePackage(bytes: Buffer, subdirectory?: string): SkillPackage {
  if (bytes.length > SKILL_BYTES) throw new Error('Skill archive exceeds byte limit');
  const zip = new AdmZip(bytes), entries = zip.getEntries();
  if (entries.length > 2048) throw new Error('Skill archive has too many entries');
  const seen = new Set<string>(); let total = 0;
  for (const entry of entries) {
    const path = skillPath(entry.entryName.replace(/\/$/, '')), key = path.normalize('NFKC').toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate/case-colliding archive entry');
    seen.add(key);
    const kind = (entry.attr >>> 16) & 0o170000;
    if (kind && kind !== 0o100000 && kind !== 0o040000) throw new Error('Skill archives cannot contain symlinks or special files');
    total += entry.header.size;
    if (entry.header.size > SKILL_FILE_BYTES || total > SKILL_BYTES) throw new Error('Skill archive expanded byte limit exceeded');
  }
  const roots = entries.filter(entry => !entry.isDirectory && /(?:^|\/)SKILL\.md$/.test(entry.entryName)).map(entry => entry.entryName.slice(0, -'SKILL.md'.length));
  const prefix = subdirectory ? skillPath(subdirectory) + '/' : roots.length === 1 ? roots[0]! : undefined;
  if (prefix === undefined || !roots.includes(prefix)) throw new Error('Select one skill subdirectory from the archive: ' + roots.slice(0, 20).join(', '));
  return packageFromFiles(entries.filter(entry => !entry.isDirectory && entry.entryName.startsWith(prefix)).map(entry => ({ path: entry.entryName.slice(prefix.length), content: entry.getData().toString('base64'), encoding: 'base64', executable: !!((entry.attr >>> 16) & 0o111) })), prefix ? prefix.slice(0, -1) : undefined);
}
export function skillArchive(files: PackageFile[], name: string): Buffer {
  const zip = new AdmZip();
  for (const file of files) zip.addFile(`${skillName(name)}/${skillPath(file.path)}`, file.bytes, '', file.executable ? 0o100700 : 0o100600);
  return zip.toBuffer();
}
