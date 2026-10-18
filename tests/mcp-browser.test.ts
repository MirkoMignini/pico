import { afterEach, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { cpSync, existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '../src/daemon.js';
import { browserSettings, prepareBrowserDirectories } from '../src/mcp-browser.js';
import { mcpSettings } from '../src/mcp-contracts.js';
import { mcpToolName } from '../src/mcp.js';
import { hash, Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { backup, restore } from '../src/backup.js';
import { loadTools, setup, source, waitFor } from './helpers.js';

const instances: ReturnType<typeof setup>[] = [];
const directories: string[] = [];
const entrypoint = fileURLToPath(new URL('./fixtures/mcp-browser-server.mjs', import.meta.url));
const invoke = <T = any>(s: ReturnType<typeof setup>, name: string, args: Record<string, unknown> = {}): Promise<T> => rpc(s.runtime, { op: `extensions.mcp.${name}`, args }) as Promise<T>;
async function instance(autonomous = false) {
  const s = setup('synthetic-browser'); instances.push(s); await s.runtime.start();
  const settings = browserSettings(s.root, { servers: [] }, entrypoint); prepareBrowserDirectories(s.root);
  if (!autonomous) settings.servers[0]!.autonomousTools = [];
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings } });
  await invoke(s, 'connect', { server: 'browser' }); return s;
}
async function approved(s: ReturnType<typeof setup>, name: string) {
  const prepared = await invoke(s, 'call', { server: 'browser', name, arguments: {} });
  const accepted = await invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true });
  expect(accepted.status).toBe('accepted');
  return { sourceId: accepted.result.originalResultSourceId, actionId: prepared.action.id };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('creates only an explicit narrow preset, with a private dedicated profile and no ambient login or server installation', async () => {
  const s = setup(); instances.push(s);
  const settings = browserSettings(s.root, { servers: [{ id: 'other', enabled: false, transport: 'stdio', command: '/usr/bin/false' }] }, entrypoint);
  expect(settings.servers[0]?.id).toBe('other');
  const browser = settings.servers[1]!;
  expect(browser).toMatchObject({ id: 'browser', readOnlyTools: [], artifactDirectory: join(s.root, 'browser-mcp', 'artifacts'), cwd: join(s.root, 'browser-mcp', 'artifacts') });
  expect('args' in browser && browser.args).toEqual(expect.arrayContaining(['--user-data-dir', join(s.root, 'browser-mcp', 'profile'), '--no-webmcp']));
  expect(browser.autonomousTools).toEqual(browser.tools);
  expect(browser.tools).not.toEqual(expect.arrayContaining(['browser_run_code']));
  expect(browser.tools).not.toContain('browser_evaluate'); expect(browser.tools).not.toContain('browser_file_upload');
  expect(existsSync(join(s.root, 'browser-mcp'))).toBe(false);
  prepareBrowserDirectories(s.root);
  for (const dir of ['profile', 'artifacts']) expect(lstatSync(join(s.root, 'browser-mcp', dir)).mode & 0o777).toBe(0o700);
  expect(() => browserSettings(s.root, settings, entrypoint)).toThrow('already exists');
  expect(() => browserSettings(s.root, { servers: [] }, 'relative/cli.js')).toThrow('absolute');
  expect(() => mcpSettings({ servers: [{ ...browser, artifactDirectory: '../escape' }] })).toThrow('absolute');
  rmSync(join(s.root, 'browser-mcp', 'profile'), { recursive: true }); symlinkSync(s.root, join(s.root, 'browser-mcp', 'profile'));
  expect(() => prepareBrowserDirectories(s.root)).toThrow('symlink');
  expect(s.faux.state.callCount).toBe(0);
});

it('requires explicit exact autonomous grants and never treats delegated effects as reads', () => {
  const server = { id: 'browser', enabled: true, transport: 'stdio', command: process.execPath, tools: ['browser_click'], autonomousTools: ['browser_click'] };
  expect(mcpSettings({ servers: [server] }).servers[0]?.autonomousTools).toEqual(['browser_click']);
  for (const invalid of [{ ...server, tools: undefined }, { ...server, autonomousTools: ['*'] }, { ...server, readOnlyTools: ['browser_click'] }, { ...server, surprise: true }]) expect(() => mcpSettings({ servers: [invalid] })).toThrow();
});

it('completes a trusted Telegram browser workflow autonomously, preserving effect receipts and linked forgetting', async () => {
  const s = await instance(true);
  const last = (request: any) => JSON.parse(request.messages.findLast((message: any) => message.role === 'toolResult').content[0].text);
  s.faux.appendResponses([
    loadTools('mcp_call', 'mcp_artifact_read', 'mcp_import'),
    fauxAssistantMessage([fauxToolCall('mcp_call', { server: 'browser', name: 'browser_navigate', arguments: { url: 'https://example.invalid' } })], { stopReason: 'toolUse' }),
    request => { expect(last(request).prepared).not.toBe(true); return fauxAssistantMessage([fauxToolCall('mcp_call', { server: 'browser', name: 'browser_snapshot', arguments: {} })], { stopReason: 'toolUse' }); },
    request => fauxAssistantMessage([fauxToolCall('mcp_artifact_read', { server: 'browser', sourceId: last(request).originalResultSourceId, file: 'page.yml' })], { stopReason: 'toolUse' }),
    request => { expect(last(request).text).toContain('[ref=e2]'); return fauxAssistantMessage([fauxToolCall('mcp_call', { server: 'browser', name: 'browser_take_screenshot', arguments: {} })], { stopReason: 'toolUse' }); },
    request => fauxAssistantMessage([fauxToolCall('mcp_import', { server: 'browser', sourceId: last(request).originalResultSourceId, contentIndex: 1 })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Synthetic screenshot imported without approval.')])
  ]);
  const run = await s.runtime.ingest({ conversationId: s.runtime.newConversation().id, requestId: 'autonomous-browser-telegram', text: 'Open the synthetic report and retain a screenshot.' }, { ...source, channel: 'telegram', identity: '7001' });
  await waitFor(() => !['queued', 'running'].includes(s.runtime.run(run.id).status));
  expect(s.runtime.run(run.id).status, s.runtime.run(run.id).error).toBe('completed');
  expect((await invoke(s, 'actions.list')).total).toBe(0);
  expect(s.store.all("SELECT status FROM operations WHERE tool='mcp_autonomous'")).toEqual([{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }]);
  expect(JSON.parse(readFileSync(join(s.root, 'browser-mcp', 'artifacts', 'navigations.json'), 'utf8'))).toEqual({ navigations: 1 });
  expect(s.runtime.extensions.toolHistoryPolicy(mcpToolName('browser', 'browser_snapshot'))).toBe('effect');
  expect(s.runtime.extensions.tools().find(tool => tool.name === mcpToolName('browser', 'browser_snapshot'))?.description).toContain('autonomous execution');
  expect((await invoke(s, 'catalog', { server: 'browser', kind: 'tools' })).entries.find((tool: any) => tool.name === 'browser_snapshot').policy).toBe('owner-delegated-effects');
  const image = s.store.get<{ id: string; source_id: string }>('SELECT id,source_id FROM documents')!;
  expect(s.runtime.memory.source(image.source_id)?.actor).toBe('tool:mcp_autonomous');
  await s.runtime.deleteKnowledge(image.id, true);
  expect(s.store.all('SELECT id FROM attachments')).toEqual([]);
  expect(s.runtime.memory.source(image.source_id)).toBeUndefined();
});

it('denies autonomous browser effects in restricted/foreign contexts and cannot grant autonomy through call arguments', async () => {
  const s = await instance(true), args = { server: 'browser', name: 'browser_navigate', arguments: { url: 'https://example.invalid' } };
  const context = { ownerId: s.config.ownerId, instanceId: s.config.instanceId, runId: crypto.randomUUID(), conversationId: '', source, mode: 'foreground' as const };
  for (const invalid of [{ ...context, mode: 'ephemeral' as const }, { ...context, mode: 'scheduled' as const }, { ...context, mode: 'review' as const }, { ...context, source: { ...source, trustedOwner: false } }, { ...context, ownerId: 'foreign-owner' }]) await expect(s.runtime.extensions.invoke('mcp_call', args, invalid, 'denied', async () => { throw new Error('unexpected'); }, undefined, undefined, undefined, true)).rejects.toThrow();
  await expect(s.runtime.extensions.invoke('mcp_call', args, context, 'repair-denied', async () => { throw new Error('unexpected'); }, undefined, undefined, undefined, false)).rejects.toThrow('restricted');
  await expect(invoke(s, 'call', { ...args, autonomousTools: ['browser_navigate'] })).rejects.toThrow('Invalid input');
  expect(existsSync(join(s.root, 'browser-mcp', 'artifacts', 'navigations.json'))).toBe(false);
});

it('journals an autonomous effect before dispatch and keeps a lost acknowledgement uncertain without replay', async () => {
  const s = await instance(true);
  await expect(invoke(s, 'call', { server: 'browser', name: 'browser_navigate', arguments: { url: 'lost-ack' } })).rejects.toThrow('acceptance is uncertain');
  expect(s.store.all("SELECT status,result FROM operations WHERE tool='mcp_autonomous'")).toEqual([{ status: 'uncertain', result: null }]);
  expect(JSON.parse(readFileSync(join(s.root, 'browser-mcp', 'artifacts', 'navigations.json'), 'utf8'))).toEqual({ navigations: 1 });
  expect((await invoke(s, 'actions.list')).total).toBe(0);
});

it('keeps exact approval when the owner has not delegated tools, regardless of server read hints', async () => {
  const s = await instance();
  const result = await invoke(s, 'call', { server: 'browser', name: 'browser_snapshot', arguments: {} });
  expect(result.prepared).toBe(true);
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_approved'")).toEqual({ count: 0 });
  for (const name of ['browser_run_code', 'browser_evaluate', 'browser_file_upload']) await expect(invoke(s, 'call', { server: 'browser', name, arguments: {} })).rejects.toThrow('not enabled');
  const snapshot = await approved(s, 'browser_snapshot');
  expect(s.runtime.memory.source(snapshot.sourceId)?.actor).toBe('tool:mcp_approved');
});

it('pauses for manual login without closing the browser, denies all dispatch and invalidates old approvals on resume', async () => {
  const s = await instance();
  const pending = await invoke(s, 'call', { server: 'browser', name: 'browser_navigate', arguments: { url: 'https://example.invalid' } });
  expect(await invoke(s, 'pause', { server: 'browser' })).toMatchObject({ paused: true });
  expect((await invoke(s, 'status')).servers[0]).toMatchObject({ state: 'connected', paused: true });
  expect(s.runtime.canApplySettings).toBe(false);
  await expect(invoke(s, 'call', { server: 'browser', name: 'browser_snapshot' })).rejects.toThrow('paused');
  await expect(invoke(s, 'actions.approve', { id: pending.action.id, digest: pending.action.digest, decision: true })).rejects.toThrow('Connection');
  expect(await invoke(s, 'resume', { server: 'browser' })).toMatchObject({ paused: false });
  expect((await invoke(s, 'actions.review', { id: pending.action.id })).status).toBe('pending');
  await expect(invoke(s, 'actions.approve', { id: pending.action.id, digest: pending.action.digest, decision: true })).rejects.toThrow('Connection');
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_approved'")).toEqual({ count: 0 });
  await approved(s, 'browser_snapshot'); expect(s.faux.state.callCount).toBe(0);
});

it('does not let pause/resume race an already accepted approval into stale dispatch', async () => {
  const s = await instance(), prepared = await invoke(s, 'call', { server: 'browser', name: 'browser_snapshot' });
  const original = s.runtime.credentials.secret.bind(s.runtime.credentials);
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(s.runtime.credentials, 'secret').mockImplementation(async name => {
    const value = await original(name);
    if (name === 'extensions.mcp.browser' && ++reads === 2) await gate;
    return value;
  });
  const approval = invoke(s, 'actions.approve', { id: prepared.action.id, digest: prepared.action.digest, decision: true });
  try {
    await waitFor(() => reads >= 2);
    await invoke(s, 'pause', { server: 'browser' }); await invoke(s, 'resume', { server: 'browser' });
  } finally { release(); }
  expect(await approval).toMatchObject({ status: 'uncertain' });
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_approved'")).toEqual({ count: 0 });
});

it('retains handoff across module restart and refuses model/Telegram resume and restricted artifact writes', async () => {
  const s = await instance(); await invoke(s, 'pause', { server: 'browser' });
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models); await s.runtime.start();
  expect((await invoke(s, 'status')).servers[0]).toMatchObject({ paused: true });
  await expect(invoke(s, 'call', { server: 'browser', name: 'browser_snapshot' })).rejects.toThrow('paused');
  expect(s.runtime.extensions.tools().some(tool => tool.name.includes('resume'))).toBe(false);
  const context = { ownerId: s.config.ownerId, instanceId: s.config.instanceId, runId: crypto.randomUUID(), conversationId: '', source, mode: 'foreground' as const };
  for (const name of ['mcp_import', 'mcp_handoff', 'mcp_artifact_read']) {
    const args = name === 'mcp_import' ? { server: 'browser', sourceId: 'operation:missing', contentIndex: 0 } : name === 'mcp_artifact_read' ? { server: 'browser', sourceId: 'operation:missing', file: 'page.yml' } : { server: 'browser' };
    for (const invalid of [{ ...context, mode: 'ephemeral' as const }, { ...context, mode: 'scheduled' as const }, { ...context, source: { ...source, trustedOwner: false } }]) await expect(s.runtime.extensions.invoke(name, args, invalid, 'denied', async () => { throw new Error('unexpected'); }, undefined, undefined, undefined, true)).rejects.toThrow();
    await expect(s.runtime.extensions.invoke(name, args, context, 'repair-denied', async () => { throw new Error('unexpected'); }, undefined, undefined, undefined, false)).rejects.toThrow('restricted');
  }
  await expect(s.runtime.extensionRpc('extensions.mcp.resume', { server: 'browser' }, { ...context, source: { ...source, channel: 'telegram' } })).rejects.toThrow('owner-terminal');
  await invoke(s, 'resume', { server: 'browser' });
});

it('reads file-backed snapshots in bounded windows without new browser effects or document imports', async () => {
  const s = await instance(), snapshot = await approved(s, 'browser_snapshot');
  await invoke(s, 'disconnect', { server: 'browser' });
  const args = { server: 'browser', sourceId: snapshot.sourceId, file: 'page.yml', maxChars: 12 };
  const first = await invoke(s, 'artifact', args);
  expect(first).toMatchObject({ origin: 'external:mcp:browser', text: '- heading "S', fromOffset: 0, nextOffset: 12, completeSource: false });
  const rest = await invoke(s, 'artifact', { ...args, fromOffset: 12, maxChars: 1000 });
  expect(rest.text).toContain('[ref=e2]'); expect(rest.nextOffset).toBeNull();
  expect((await invoke(s, 'artifact', { ...args, maxChars: 1000 })).completeSource).toBe(true);
  await expect(invoke(s, 'artifact', { ...args, file: '../profile/Cookies' })).rejects.toThrow();
  await expect(invoke(s, 'artifact', { ...args, file: 'page.ym' })).rejects.toThrow('reported');
  writeFileSync(join(s.root, 'browser-mcp', 'artifacts', 'page.yml'), Buffer.from([255, 0]));
  await expect(invoke(s, 'artifact', args)).rejects.toThrow();
  expect(s.store.all('SELECT id FROM documents')).toEqual([]);
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_approved'")).toEqual({ count: 1 });
  expect((await invoke(s, 'status')).servers[0].state).toBe('not_connected');
});

it('imports screenshots and downloads from original receipts without reconnecting or replaying effects', async () => {
  const s = await instance(), screenshot = await approved(s, 'browser_take_screenshot'), download = await approved(s, 'browser_pdf_save');
  await invoke(s, 'disconnect', { server: 'browser' });
  const imageArgs = { server: 'browser', sourceId: screenshot.sourceId, contentIndex: 1 };
  const image = await invoke(s, 'import', imageArgs);
  expect(await invoke(s, 'import', imageArgs)).toMatchObject({ attachmentId: image.attachmentId, documentId: image.documentId });
  expect(await invoke(s, 'import', { contentIndex: 1, sourceId: screenshot.sourceId, server: 'browser' })).toMatchObject({ attachmentId: image.attachmentId, documentId: image.documentId });
  expect(s.runtime.knowledge.document(image.documentId)).toMatchObject({ source_id: screenshot.sourceId, channel: 'integration' });
  expect(s.store.get('SELECT source_id,mime FROM attachments WHERE id=?', image.attachmentId)).toEqual({ source_id: screenshot.sourceId, mime: 'image/png' });
  const pdf = await invoke(s, 'import', { server: 'browser', sourceId: download.sourceId, file: 'report.pdf' });
  expect(Buffer.from((await s.runtime.media.read(pdf.attachmentId)).bytes).toString()).toContain('%PDF-1.4');
  expect(s.store.get("SELECT count(*) count FROM operations WHERE tool='mcp_approved'")).toEqual({ count: 2 });
  expect((await invoke(s, 'status')).servers[0].state).toBe('not_connected');
  writeFileSync(join(s.root, 'browser-mcp', 'artifacts', 'report.pdf'), '%PDF-1.4\nChanged later');
  await expect(invoke(s, 'import', { server: 'browser', sourceId: download.sourceId, file: 'report.pdf' })).rejects.toThrow('changed bytes');
});

it('rejects fabricated, wrong-server, incomplete, traversal, linked, unreported and oversized imports', async () => {
  const s = await instance(), download = await approved(s, 'browser_pdf_save');
  const base = { server: 'browser', sourceId: download.sourceId };
  for (const args of [{ ...base }, { ...base, file: 'report.pdf', contentIndex: 0 }, { ...base, contentIndex: 0 }, { ...base, sourceId: 'operation:missing', file: 'report.pdf' }, { ...base, file: '../profile/Cookies' }, { ...base, file: '/etc/passwd' }, { ...base, file: '.env' }, { ...base, file: 'not-reported.pdf' }, { ...base, contentIndex: 100 }, { ...base, file: 'report.pdf', surprise: true }]) await expect(invoke(s, 'import', args)).rejects.toThrow();
  const file = join(s.root, 'browser-mcp', 'artifacts', 'report.pdf'); rmSync(file); symlinkSync(join(s.root, 'config.json'), file);
  await expect(invoke(s, 'import', { ...base, file: 'report.pdf' })).rejects.toThrow('regular');
  rmSync(file); linkSync(join(s.root, 'config.json'), file);
  await expect(invoke(s, 'import', { ...base, file: 'report.pdf' })).rejects.toThrow('regular');
  rmSync(file); writeFileSync(file, Buffer.alloc(s.config.limits.attachmentBytes + 1));
  await expect(invoke(s, 'import', { ...base, file: 'report.pdf' })).rejects.toThrow('bounded');
  const other = await instance();
  await expect(invoke(other, 'import', { ...base, file: 'report.pdf' })).rejects.toThrow('retained');
  expect(s.store.all('SELECT id FROM attachments')).toEqual([]);
});

it('binds artifact directories and server identity to the acquisition receipt and rejects uncertain originals', async () => {
  const s = await instance(), download = await approved(s, 'browser_pdf_save');
  const args = { server: 'browser', sourceId: download.sourceId, file: 'report.pdf' };
  s.store.run("UPDATE operations SET status='uncertain' WHERE id=?", download.sourceId.slice(10));
  await expect(invoke(s, 'import', args)).rejects.toThrow('completed');
  s.store.run("UPDATE operations SET status='completed' WHERE id=?", download.sourceId.slice(10));
  const directory = join(s.root, 'different-artifacts'); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'report.pdf'), 'unrelated private bytes');
  const current = await rpc(s.runtime, { op: 'extensions.setup', args: { id: 'mcp' } }) as { settings: { servers: Record<string, unknown>[] } };
  await rpc(s.runtime, { op: 'extensions.configure', args: { id: 'mcp', settings: { servers: [{ ...current.settings.servers[0], artifactDirectory: directory }, { ...current.settings.servers[0], id: 'other' }] } } });
  await expect(invoke(s, 'import', args)).rejects.toThrow('directory changed');
  await expect(invoke(s, 'import', { ...args, server: 'other' })).rejects.toThrow('selected MCP server');
  expect(s.store.all('SELECT id FROM attachments')).toEqual([]);
});

it('erases imported browser derivatives when the originating owner evidence is forgotten', async () => {
  const s = await instance();
  s.faux.appendResponses([
    loadTools('mcp_call'),
    fauxAssistantMessage([fauxToolCall('mcp_call', { server: 'browser', name: 'browser_take_screenshot', arguments: {} })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('A terminal approval is required.')])
  ]);
  const run = await s.runtime.ingest({ conversationId: s.runtime.newConversation().id, requestId: 'synthetic-browser-evidence', text: 'Capture the synthetic report page.' }, source);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  const user = s.store.get<{ id: string; text: string }>("SELECT id,text FROM messages WHERE run_id=? AND role='user'", run.id)!;
  const action = (await invoke(s, 'actions.list')).actions[0], review = await invoke(s, 'actions.review', { id: action.id });
  const accepted = await invoke(s, 'actions.approve', { id: action.id, digest: review.digest, decision: true });
  const image = await invoke(s, 'import', { server: 'browser', sourceId: accepted.result.originalResultSourceId, contentIndex: 1 });
  const memory = s.runtime.memory.remember({ sourceId: user.id, entity: `owner:${s.config.ownerId}`, kind: 'fact', key: 'synthetic-browser-input', value: user.text, quote: user.text, eventAt: Date.now() }, false);
  await s.runtime.forget(memory.id);
  expect(s.store.get('SELECT id FROM documents WHERE id=? AND deleted_at IS NULL', image.documentId)).toBeUndefined();
  expect(s.runtime.memory.source(image.sourceId)).toBeUndefined();
  expect(existsSync(join(s.root, 'attachments', image.attachmentId))).toBe(false);
});

it('forgets imported bytes, original binary receipts and approval copies, and blocks resurrection after restore', async () => {
  const s = await instance(), screenshot = await approved(s, 'browser_take_screenshot');
  const args = { server: 'browser', sourceId: screenshot.sourceId, contentIndex: 1 }, image = await invoke(s, 'import', args);
  writeFileSync(join(s.root, 'browser-mcp', 'profile', 'synthetic-cookie'), 'synthetic-profile-only');
  const snapshot = await backup(s.store), external = mkdtempSync(join(tmpdir(), 'pico-browser-backup-')); directories.push(external);
  cpSync(snapshot.path, external, { recursive: true });
  expect(snapshot.manifest.files.some(file => file.path.startsWith('browser-mcp/'))).toBe(false);
  await s.runtime.deleteKnowledge(image.documentId, true);
  expect(s.store.get('SELECT hash FROM deletions WHERE hash=?', hash(`source:${screenshot.sourceId}`))).toBeDefined();
  expect(s.runtime.memory.source(screenshot.sourceId)).toBeUndefined();
  expect(s.store.get('SELECT value FROM extension_storage WHERE extension_id=? AND key=?', 'mcp', `action:${screenshot.actionId}`)).toBeUndefined();
  expect(existsSync(join(s.root, 'attachments', image.attachmentId))).toBe(false);
  expect(existsSync(join(s.root, 'browser-mcp', 'profile', 'synthetic-cookie'))).toBe(true);
  await expect(invoke(s, 'import', args)).rejects.toThrow('retained');
  expect(existsSync(snapshot.path)).toBe(false);
  expect(s.faux.state.callCount).toBe(0);
  await s.runtime.close(); s.store.close(); instances.splice(instances.indexOf(s), 1); directories.push(s.root);
  await restore(s.root, external, true);
  const restored = new Store(s.root, s.config);
  try {
    expect(restored.all('SELECT id FROM attachments')).toEqual([]);
    expect(restored.get('SELECT id FROM documents WHERE id=? AND deleted_at IS NULL', image.documentId)).toBeUndefined();
    expect(restored.get('SELECT value FROM extension_storage WHERE extension_id=? AND key=?', 'mcp', `action:${screenshot.actionId}`)).toBeUndefined();
    expect(existsSync(join(s.root, 'attachments', image.attachmentId))).toBe(false);
  } finally { restored.close(); }
});
