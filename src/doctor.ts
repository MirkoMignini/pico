import { closeSync, existsSync, lstatSync, openSync, readSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from './client.js';
import { existingPrivateDirectory, loadConfig, readPrivate } from './config.js';
import { Credentials } from './credentials.js';
import { ModelAccess } from './models.js';
import { configurationReadiness, type Readiness } from './readiness.js';
import { HealthSchema, type Health } from './health.js';
import { validate } from './contracts.js';
import { NODE_VERSION, PNPM_VERSION, SCHEMA_VERSION, VERSION } from './version.js';

export interface DoctorCheck { id: string; status: 'pass' | 'warn' | 'fail'; message: string; remedy?: string }
export interface DoctorReport { version: string; node: string; expectedNode: string; ok: boolean; checks: DoctorCheck[]; readiness?: Readiness }
export async function doctor(root: string, offline = false): Promise<DoctorReport> {
  const report: DoctorReport = { version: VERSION, node: process.versions.node, expectedNode: NODE_VERSION, ok: false, checks: [] };
  const add = (id: string, status: DoctorCheck['status'], message: string, remedy?: string) => report.checks.push({ id, status, message, ...(remedy ? { remedy } : {}) });
  add('runtime', process.versions.node === NODE_VERSION ? 'pass' : 'fail', `Node ${NODE_VERSION} and pnpm ${PNPM_VERSION} are pinned.`, 'Select the pinned runtime before starting or installing Pico.');
  add('platform', ['darwin', 'linux'].includes(process.platform) ? 'pass' : 'fail', 'Supported native platforms: macOS and Linux with private Unix sockets.');
  try { existingPrivateDirectory(root); }
  catch { add('instance', 'fail', 'Instance is missing, not owned by this OS user, symlinked or not private.', 'Initialize a NEW private directory once with pico --instance PATH init; fix permissions on existing data instead of reinitializing it.'); return report; }
  add('instance', 'pass', 'Instance directory is owned by this OS user and private.');
  let config;
  try { for (const name of ['config.json', 'ipc.token']) if (lstatSync(join(root, name)).size > 4_000_000) throw new Error(); config = loadConfig(root).config; add('configuration', 'pass', 'Saved configuration is valid.'); }
  catch { add('configuration', 'fail', 'Configuration or IPC token is missing, invalid, unreadable or has unsafe permissions.', 'Correct the existing private files; never initialize over retained owner data. No values are included in this report.'); return report; }
  try { if (!/^[a-f0-9]{64}$/.test(readPrivate(join(root, 'ipc.token')).trim())) throw new Error(); add('ipc-token', 'pass', 'Private IPC token format is valid.'); }
  catch { add('ipc-token', 'fail', 'IPC token format is invalid.', 'Use the offline credential/IPC recovery procedure; do not publish or replace a live token.'); }
  for (const name of ['attachments', 'artifacts', 'backups', 'skills']) {
    try { existingPrivateDirectory(join(root, name)); add(name, 'pass', 'Managed directory exists and is private.'); }
    catch { add(name, 'fail', 'Managed directory is missing or has unsafe ownership/permissions.', 'Repair the selected instance directory without deleting its retained files.'); }
  }
  try {
    const space = statfsSync(root), free = space.bavail * space.bsize;
    add('disk', free < 1_000_000_000 ? 'warn' : 'pass', free < 1_000_000_000 ? 'Less than 1 GB of disk space is available.' : 'At least 1 GB of disk space is available.', 'Budget separately for originals, backups and several GiB of optional semantic-model weights.');
  } catch { add('disk', 'warn', 'Available disk space could not be checked.'); }
  const db = join(root, 'pico.sqlite');
  if (!existsSync(db)) add('database', 'warn', 'No operational database yet. The first explicit daemon start creates it.', 'Use pico --instance PATH serve or service start when ready. Doctor never creates/migrates a database.');
  else {
    let fd: number | undefined;
    try {
      const stat = lstatSync(db);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error();
      fd = openSync(db, 'r'); const bytes = Buffer.alloc(100);
      if (readSync(fd, bytes, 0, 100, 0) !== 100 || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') throw new Error();
      const version = bytes.readUInt32BE(60);
      add('database', version > SCHEMA_VERSION ? 'fail' : 'pass', version > SCHEMA_VERSION ? 'Database header is newer than this build.' : 'Private SQLite header is readable; offline integrity and WAL contents are not verified.', 'Do not delete database/WAL files. Full integrity is checked only through an already running daemon.');
    } catch { add('database', 'fail', 'Database is unreadable, unsafe or lacks a valid SQLite header.', 'Preserve database/WAL files and follow offline backup/restore recovery.'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  try {
    if (existsSync(join(root, 'secrets.json')) && lstatSync(join(root, 'secrets.json')).size > 4_000_000) throw new Error();
    const credentials = new Credentials(root), models = new ModelAccess(credentials, config);
    await credentials.list(); report.readiness = await configurationReadiness(config, credentials, models);
    add('vault', 'pass', 'Private credential metadata is readable; no credential is returned or refreshed.');
  } catch { add('vault', 'fail', 'Credential metadata is invalid, unreadable or unsafe.', 'Use private masked setup/recovery. Doctor does not print vault values or errors.'); }
  if (offline) add('daemon', 'warn', 'Offline requested: no daemon connection attempted; no external checks performed.');
  else {
    try {
      const result = validate<Health>(HealthSchema, await new Client(root).rpc('health', {}, 3000));
      report.readiness = result.readiness;
      add('daemon', 'pass', 'Authenticated local daemon responded; no daemon was started.');
      add('daemon-version', result.version === VERSION ? 'pass' : 'warn', result.version === VERSION ? 'CLI and daemon report the same version.' : 'CLI and daemon versions differ; the running process has not been upgraded.', 'Close TUI clients, finish work, back up, then explicitly restart the selected service.');
      add('integrity', result.database === 'ok' ? 'pass' : 'fail', result.database === 'ok' ? 'Running database quick_check passed.' : 'Running database quick_check failed.', 'Preserve data and consult offline recovery; quick_check is not a complete backup/restore or security test.');
      add('work', result.idle ? 'pass' : 'warn', result.idle ? 'No active work, delivery or sign-in blocks maintenance.' : 'Work, delivery or sign-in currently blocks maintenance.', 'Wait; do not force cancellation or restart to make diagnostics pass.');
      if (result.failedProcessing) add('processing', 'warn', 'Failed or uncertain processing needs private inspection.', 'Inspect status privately; explicitly retry uncertain billed work only after reviewing its receipts.');
      if (result.uncertainDeliveries) add('delivery', 'warn', 'Uncertain deliveries require owner review.', 'Inspect /notifications. Do not replay a send to recover its acknowledgment.');
      if (result.extensionErrors) add('extensions', 'warn', 'One or more trusted extensions failed to load.', 'Inspect /extensions privately; doctor does not expose module paths or errors.');
    } catch { add('daemon', 'warn', 'No compatible authenticated daemon health response within three seconds.', 'Run serve explicitly for local startup diagnostics, or service status. Existing daemons are never replaced; legacy builds may lack health.'); }
  }
  for (const item of report.readiness?.items ?? []) {
    if (item.enabled && (!item.configured || item.credential === 'missing')) add(`setup-${item.id}`, item.id === 'model' ? 'fail' : 'warn', 'Enabled service needs configuration or credentials.', item.action);
  }
  report.ok = !report.checks.some(check => check.status === 'fail');
  return report;
}
export function formatDoctor(report: DoctorReport): string {
  return [`Pico ${report.version} · ${report.ok ? 'no blocking local failures' : 'attention required'}`,
    ...report.checks.map(check => `[${check.status.toUpperCase()}] ${check.id}: ${check.message}${check.status !== 'pass' && check.remedy ? `\n  Next: ${check.remedy}` : ''}`),
    ...report.readiness?.items.map(item => `${item.id}: ${item.enabled ? 'enabled' : 'disabled'} · configured ${item.configured ? 'yes' : 'no'} · credential ${item.credential} · authenticated ${item.authenticated} · reachable ${item.reachable} · tested ${item.tested}`) ?? [],
    'This allowlisted report omits owner IDs/names, paths, addresses, content, credentials and raw errors. Live model/connector quality and delivery are not certified.'].join('\n') + '\n';
}
