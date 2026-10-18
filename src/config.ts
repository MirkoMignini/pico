import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Type } from 'typebox';
import { ConfigSchema, validate, type Config } from './contracts.js';

export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return existingPrivateDirectory(path);
}
export function existingPrivateDirectory(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('Instance directory must be owned by this OS user and not a symlink');
  if ((stat.mode & 0o077) !== 0) throw new Error('Instance directory is not private: chmod 700 required');
  return realpathSync(path);
}
export function atomicWrite(path: string, content: string | Uint8Array): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error(`Unsafe permissions: ${path}`);
}
export function readPrivate(path: string): string {
  assertPrivateFile(path);
  return readFileSync(path, 'utf8');
}
export function initialize(path: string, name: string): Config {
  const root = privateDirectory(resolve(path));
  if (existsSync(join(root, 'config.json'))) throw new Error('Instance already initialized');
  const config: Config = {
    version: 1, ownerId: randomUUID(), ownerName: name, instanceId: randomUUID(), timezone: 'Europe/Rome',
    model: { provider: 'deepseek', id: 'deepseek-flash' },
    limits: { activeRuns: 2, turns: 12, runTimeoutMs: 120_000, contextChars: 48_000, attachmentBytes: 10_000_000, notificationsPerDay: 30, backgroundIntervalMs: 5000 },
    embeddings: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
    search: { provider: 'duckduckgo' },
    quietHours: { start: 23, end: 7 }, retention: { backupDays: 14, mediaDays: 365 }
  };
  validate<Config>(ConfigSchema,config);
  atomicWrite(join(root, 'config.json'), JSON.stringify(config, null, 2));
  atomicWrite(join(root, 'ipc.token'), randomBytes(32).toString('hex'));
  for (const dir of ['attachments', 'artifacts', 'backups', 'skills']) privateDirectory(join(root, dir));
  return config;
}
export function loadConfig(path: string): { root: string; config: Config; token: string; socket: string } {
  const root = existingPrivateDirectory(resolve(path));
  const raw = JSON.parse(readPrivate(join(root, 'config.json'))) as Record<string, unknown>;
  // Read retired configuration as historical data; do not rewrite it or grant native authority.
  if (raw && typeof raw === 'object' && 'sandbox' in raw) {
    validate(Type.Object({ socket: Type.String({ minLength: 1, maxLength: 32_000 }), credential: Type.String({ minLength: 1, maxLength: 32_000 }) }, { additionalProperties: false }), raw.sandbox);
    delete raw.sandbox;
  }
  const config = validate<Config>(ConfigSchema, raw);
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  return { root, config, token: readPrivate(join(root, 'ipc.token')).trim(), socket: join(root, 'daemon.sock') };
}
export function tokenMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function secureFile(path: string): void { chmodSync(path, 0o600); }
