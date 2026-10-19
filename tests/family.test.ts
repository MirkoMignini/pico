import { afterEach, expect, it, vi } from 'vitest';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, cpSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, source, waitFor, loadTools } from './helpers.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/daemon.js';
import { Client } from '../src/client.js';
import { Store, id, json } from '../src/store.js';
import { atomicWrite } from '../src/config.js';
import { backup, exportData, restore } from '../src/backup.js';
import type { Envelope } from '../src/contracts.js';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function instance(name = 'Owner A') {
  const s = setup(name); await s.runtime.close(); s.store.close();
  s.config.limits.backgroundIntervalMs = 600_000;
  atomicWrite(join(s.root, 'config.json'), json(s.config));
  const daemon = await serve(s.root, { runtimeFactory: store => new Runtime(store, s.runtime.models) });
  cleanup.push(async () => { await daemon.close(); rmSync(s.root, { recursive: true, force: true }); });
  const client = new Client(s.root);
  return { ...s, daemon, runtime: daemon.runtime, store: daemon.runtime.store, client };
}
type Instance = Awaited<ReturnType<typeof instance>>;
async function pair(reminders = true) {
  const a = await instance('Owner A'), b = await instance('Owner B');
  const cardA = await a.client.rpc('family.identity'), cardB = await b.client.rpc('family.identity');
  await a.client.rpc('family.add', { card: cardB, alias: 'Owner B', allowReminders: reminders });
  await b.client.rpc('family.add', { card: cardA, alias: 'Owner A', allowReminders: reminders });
  return { a, b, cardA: cardA as any, cardB: cardB as any };
}
const call = (s: Instance, args: Record<string, unknown>) => s.client.rpc<any>('family', args);
const context = (s: Instance, mode: Envelope['mode'] = 'foreground', trustedOwner = true): Envelope => ({
  ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: '', runId: id(), source: { ...source, trustedOwner }, mode
});
async function packet(a: Instance, b: Instance, action: string, args: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const encoded = await a.runtime.credentials.secret('family.signingKey');
  const key = createPrivateKey({ key: Buffer.from(encoded!, 'base64'), format: 'der', type: 'pkcs8' });
  const payload = { version: 1, id: id(), from: a.config.instanceId, to: b.config.instanceId, expiresAt: Date.now() + 60_000, action, args, ...overrides };
  return { payload, signature: sign(null, Buffer.from(json(payload)), key).toString('base64') };
}
const receive = async (s: Instance, value: unknown) => await s.runtime.family.receive(value) as any;

it('uses independent public identities and explicit bilateral authorization, without sharing owner tokens', async () => {
  const a = await instance(), b = await instance('Owner B');
  const [cardA, again, cardB] = await Promise.all([a.runtime.family.identity(), a.runtime.family.identity(), b.runtime.family.identity()]);
  expect(cardA.publicKey).toBe(again.publicKey); expect(cardA.publicKey).not.toBe(cardB.publicKey);
  expect(json(cardA)).not.toContain('PRIVATE'); expect(json(cardA)).not.toContain(readFileSync(join(a.root, 'ipc.token'), 'utf8').trim());
  await a.client.rpc('family.add', { card: cardB, alias: 'Owner B', allowReminders: false });
  await expect(call(a, { action: 'catalog', member: 'Owner B' })).rejects.toThrow('acceptance unknown');
  expect(b.store.all('SELECT * FROM family_requests')).toEqual([]);
  await b.client.rpc('family.add', { card: cardA, alias: 'Owner A', allowReminders: false });
  expect((await call(a, { action: 'catalog', member: 'Owner B' })).result.lists).toEqual([]);
  expect((await a.client.rpc<any>('family.receipts')).requests.map((r: any) => r.status)).toContain('uncertain');
});

it('uses exact authenticated instance IDs before display aliases that resemble another member ID', async () => {
  const { a, b } = await pair(), c = await instance('Owner C');
  const cardC = await c.runtime.family.identity();
  await a.client.rpc('family.add', { card: cardC, alias: b.config.instanceId, allowReminders: false });
  expect((await call(a, { action: 'catalog', member: b.config.instanceId })).instanceId).toBe(b.config.instanceId);
  expect(a.store.get<any>("SELECT peer_id FROM family_requests WHERE direction='out'")!.peer_id).toBe(b.config.instanceId);
});

it('delivers a consented one-shot through the recipient configuration, without inference or sender delivery', async () => {
  const { a, b } = await pair();
  const sender = vi.fn(async () => ({ remoteId: 'wrong' })), recipient = vi.fn(async () => ({ remoteId: 'recipient-receipt' }));
  a.runtime.scheduler.deliveries.set('phone', { send: sender }); b.runtime.scheduler.deliveries.set('phone', { send: recipient });
  const at = new Date(Date.now() + 60_000).toISOString();
  const result = await call(a, { action: 'remind', member: 'Owner B', text: 'Bring the parcel.', at });
  expect(result.result).toMatchObject({ accepted: true, delivered: false, status: 'active' });
  expect(a.runtime.scheduler.list()).toEqual([]);
  expect(b.runtime.scheduler.list()).toHaveLength(1);
  expect(JSON.parse((b.runtime.scheduler.list()[0] as any).definition)).toMatchObject({ destination: 'phone', kind: 'reminder' });
  await b.runtime.scheduler.tick(Date.parse(at) + 1);
  expect(recipient).toHaveBeenCalledOnce(); expect(recipient.mock.calls[0]).toBeDefined(); expect(sender).not.toHaveBeenCalled();
  expect(b.store.get<any>('SELECT status FROM outbox')!.status).toBe('sent');
  expect(a.faux.state.callCount).toBe(0); expect(b.faux.state.callCount).toBe(0);
});

it('denies reminders by default and rejects past times, recurrence, agent jobs and arbitrary destinations', async () => {
  const { a, b, cardA } = await pair(false), at = new Date(Date.now() + 60_000).toISOString();
  await expect(call(a, { action: 'remind', member: 'Owner B', text: 'Hello', at })).rejects.toThrow('not authorized reminders');
  await b.client.rpc('family.add', { card: cardA, alias: 'Owner A', allowReminders: true });
  await expect(call(a, { action: 'remind', member: 'Owner B', text: 'Hello', at: '2000-01-01T00:00:00Z' })).rejects.toThrow('future');
  for (const extra of [{ destination: 'telegram:999' }, { kind: 'agent' }, { cron: '* * * * *' }, { ownerId: a.config.ownerId }]) {
    const reply = await receive(b, await packet(a, b, 'remind', { text: 'Hello', at, ...extra }));
    expect(reply.payload.ok).toBe(false);
  }
  expect(b.runtime.scheduler.list()).toEqual([]);
});

it('keeps private lists, prose, files and historical revisions out of shared reads', async () => {
  const { a, b } = await pair();
  const shared = a.runtime.knowledge.createNote('Shared groceries', 'PRIVATE PROSE MUST NOT LEAVE.\n- [ ] Apples', 'shared');
  const privateList = a.runtime.knowledge.createNote('Private plans', '- [ ] Private entry', 'private');
  expect((await call(b, { action: 'catalog', member: 'Owner A' })).result.lists).toEqual([]);
  await expect(call(b, { action: 'read', member: 'Owner A', id: privateList.id })).rejects.toThrow('not shared');
  await call(a, { action: 'share', member: 'Owner B', id: shared.id, permission: 'read' });
  const catalog = (await call(b, { action: 'catalog', member: 'Owner A' })).result;
  expect(catalog.lists).toEqual([{ id: shared.id, title: 'Shared groceries', revision: 1, permission: 'read' }]);
  const result = await call(b, { action: 'read', member: 'Owner A', id: shared.id });
  expect(result.result.items[0].text).toBe('Apples');
  expect(json(result)).not.toContain('PRIVATE PROSE'); expect(json(result)).not.toContain('pikobot:');
  expect(b.store.all('SELECT * FROM documents')).toEqual([]);
  expect((await receive(a, await packet(b, a, 'read', { id: shared.id, revision: 1 }))).payload.ok).toBe(false);
  expect((await receive(a, await packet(b, a, 'read', { id: shared.id, action: 'original' }))).payload.ok).toBe(false);
  await expect(call(b, { action: 'add', member: 'Owner A', id: shared.id, items: ['Milk'] })).rejects.toThrow('permission denied');
});

it('creates an empty shared checklist atomically with read/write access by default', async () => {
  const { a, b } = await pair();
  const created = await call(a, { action: 'create', title: 'Shared shopping', member: 'Owner B', items: [] });
  expect(created).toMatchObject({ title: 'Shared shopping', revision: 1, effect: 'created', shared: true, permission: 'edit' });
  expect((await call(b, { action: 'catalog', member: 'Owner A' })).result.lists).toEqual([{ id: created.id, title: 'Shared shopping', revision: 1, permission: 'edit' }]);
  expect((await call(b, { action: 'read', member: 'Owner A', id: created.id })).result.items).toEqual([]);
  await call(b, { action: 'add', member: 'Owner A', id: created.id, items: ['Milk'] });
  expect(a.runtime.knowledge.items(created.id).map(item => item.text)).toEqual(['Milk']);
  expect(b.store.all('SELECT * FROM documents')).toEqual([]);
});

it.each(['read', 'edit'])('honors explicit %s permission during shared checklist creation', async permission => {
  const { a, b } = await pair();
  const created = await call(a, { action: 'create', title: 'Selected checklist', member: 'Owner B', items: ['Apples'], permission });
  expect(created.permission).toBe(permission);
  expect((await call(b, { action: 'read', member: 'Owner A', id: created.id })).result.items[0].text).toBe('Apples');
  const add = () => call(b, { action: 'add', member: 'Owner A', id: created.id, items: ['Milk'] });
  if (permission === 'read') await expect(add()).rejects.toThrow('permission denied');
  else await add();
  expect(a.runtime.knowledge.items(created.id)).toHaveLength(permission === 'read' ? 1 : 2);
});

it('defaults new share requests to edit without retroactively changing explicit read-only grants', async () => {
  const { a, b } = await pair(), k = a.runtime.knowledge;
  const readOnly = k.createNote('Read only', '- [ ] Original', 'read-only'), editable = k.createNote('Collaborative', '- [ ] Original', 'collaborative');
  await call(a, { action: 'share', member: 'Owner B', id: readOnly.id, permission: 'read' });
  expect(await call(a, { action: 'share', member: 'Owner B', id: editable.id })).toMatchObject({ shared: true, permission: 'edit' });
  await call(b, { action: 'add', member: 'Owner A', id: editable.id, items: ['Milk'] });
  await expect(call(b, { action: 'add', member: 'Owner A', id: readOnly.id, items: ['Milk'] })).rejects.toThrow('permission denied');
  expect(k.items(readOnly.id)).toHaveLength(1);
});

it('rejects malformed shared creation and unknown/revoked members without creating a private fallback', async () => {
  const { a } = await pair();
  const request = { action: 'create', title: 'New shared list', member: 'Owner B', items: [] };
  for (const invalid of [
    { ...request, permission: 'all' }, { ...request, id: id() }, { ...request, ownerId: a.config.ownerId },
    { ...request, items: [''] }, { ...request, items: ['First\nSecond'] }, { ...request, items: ['Injected <!-- item:fake -->'] },
    { ...request, title: undefined }, { ...request, items: undefined },
    { action: 'add', member: 'Owner B', id: id(), items: [] }
  ]) await expect(call(a, invalid)).rejects.toThrow('Invalid input');
  await expect(call(a, { ...request, member: 'Unknown owner' })).rejects.toThrow('unknown');
  await a.client.rpc('family.revoke', { member: 'Owner B' });
  await expect(call(a, request)).rejects.toThrow('revoked');
  expect(a.store.all('SELECT * FROM documents')).toEqual([]);
  expect(a.store.all('SELECT * FROM family_shares')).toEqual([]);
});

it('rolls back canonical list creation together with its grant if sharing cannot commit', async () => {
  const { a } = await pair();
  vi.spyOn(a.store, 'linkSource').mockImplementationOnce(() => { throw new Error('Synthetic grant journal failure'); });
  await expect(call(a, { action: 'create', title: 'Atomic list', member: 'Owner B', items: ['Original'] })).rejects.toThrow('Synthetic grant journal failure');
  expect(a.store.all('SELECT * FROM documents')).toEqual([]);
  expect(a.store.all('SELECT * FROM document_revisions')).toEqual([]);
  expect(a.store.all('SELECT * FROM family_shares')).toEqual([]);
});

it('executes scripted create-and-share from a single Telegram turn without an explicit permission or placeholder items', async () => {
  const { a, b } = await pair(), c = a.runtime.newConversation('Shared creation', false, 'telegram');
  const args = { action: 'create', title: 'Shared shopping', member: 'Owner B', items: [] };
  const tool = a.runtime.extensions.tools().find(tool => tool.name === 'family')!;
  expect(tool.description).toContain('permission defaults to edit (read+write)');
  expect(a.runtime.extensions.instructions(context(a), new Set(['family']))).toContain('Unqualified sharing means edit (read and write)');
  expect(a.runtime.extensions.instructions(context(a), new Set(['lists']))).toContain('use family create');
  a.faux.appendResponses([loadTools('family'), fauxAssistantMessage([fauxToolCall('family', args)], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Created and shared with read/write access.')])]);
  const input = { conversationId: c.id, requestId: id(), text: 'Crea una lista della spesa condivisa con Owner B.' };
  const sender = { channel: 'telegram', identity: '12345', trustedOwner: true };
  const run = await a.runtime.ingest(input, sender);
  expect((await a.runtime.ingest(input, sender)).id).toBe(run.id);
  await waitFor(() => a.runtime.run(run.id).status === 'completed');
  const doc = a.store.get<any>('SELECT * FROM documents')!, message = a.store.get<any>("SELECT id FROM messages WHERE run_id=? AND role='user'", run.id)!;
  expect(a.store.all('SELECT * FROM documents')).toHaveLength(1);
  expect(doc).toMatchObject({ title: 'Shared shopping', source_id: message.id });
  expect(a.store.get<any>('SELECT * FROM family_shares')).toMatchObject({ document_id: doc.id, permission: 'edit', source_id: message.id });
  expect(a.runtime.knowledge.items(doc.id)).toEqual([]);
  await call(b, { action: 'add', member: 'Owner A', id: doc.id, items: ['Milk'] });
  expect(a.runtime.knowledge.items(doc.id)[0]!.text).toBe('Milk');
});

it('edits one authoritative list with stable item IDs, current revisions and external authorship', async () => {
  const { a, b } = await pair(), k = a.runtime.knowledge;
  const doc = k.createNote('Packing', '- [ ] Jacket', 'packing'), first = k.items(doc.id)[0]!;
  await call(a, { action: 'share', member: 'Owner B', id: doc.id, permission: 'edit' });
  const added = await call(b, { action: 'add', member: 'Owner A', id: doc.id, items: ['Bottle', 'Passport'] });
  expect(added.result).toMatchObject({ revision: 2, effect: 'added' }); expect(k.items(doc.id)[0]!.id).toBe(first.id);
  expect(JSON.parse(k.revision(doc.id).conversion!).authoredBy).toBe(`external:family:${b.config.instanceId}`);
  await expect(call(b, { action: 'update', member: 'Owner A', id: doc.id, itemId: first.id, expectedRevision: 1, completed: true })).rejects.toThrow('Revision conflict');
  await call(b, { action: 'update', member: 'Owner A', id: doc.id, itemId: first.id, expectedRevision: 2, completed: true });
  const page = (await call(b, { action: 'read', member: 'Owner A', id: doc.id, limit: 1 })).result;
  expect(page).toMatchObject({ revision: 3, allItems: 3, nextOffset: 1 }); expect(page.items[0].completed).toBe(true);
  await call(b, { action: 'remove', member: 'Owner A', id: doc.id, itemId: first.id, expectedRevision: 3 });
  expect(k.items(doc.id).map(i => i.text)).toEqual(['Bottle', 'Passport']); expect(k.items(doc.id, 1)[0]!.completed).toBe(false);
  expect(json(a.store.all('SELECT * FROM family_requests'))).not.toContain('Passport');
});

it('deduplicates accepted mutations and rejects changed-body, expired, forged and wrong-recipient requests', async () => {
  const { a, b } = await pair(), at = new Date(Date.now() + 60_000).toISOString();
  const p = await packet(a, b, 'remind', { text: 'Check the parcel.', at });
  const first = await receive(b, p), duplicate = await receive(b, p);
  expect(first.payload.ok).toBe(true); expect(duplicate.payload.result.id).toBe(first.payload.result.id);
  expect(b.runtime.scheduler.list()).toHaveLength(1);
  const changed = await packet(a, b, 'remind', { text: 'Different text', at }, { id: p.payload.id });
  expect((await receive(b, changed)).payload).toMatchObject({ ok: false, error: expect.stringContaining('changed content') });
  for (const invalid of [await packet(a, b, 'catalog', {}, { expiresAt: Date.now() - 1 }), await packet(a, b, 'catalog', {}, { to: id() }), { ...p, signature: 'A'.repeat(86) + '==' }]) {
    await expect(b.runtime.family.receive(invalid)).rejects.toThrow();
  }
  expect(b.runtime.scheduler.list()).toHaveLength(1);
});

it('enforces reminder quotas and authenticated replay rate limits', async () => {
  const { a, b } = await pair(), at = new Date(Date.now() + 60_000).toISOString();
  for (let i = 0; i < 20; i++) expect((await receive(b, await packet(a, b, 'remind', { text: `Request ${i}`, at }))).payload.ok).toBe(true);
  expect((await receive(b, await packet(a, b, 'remind', { text: 'Too many', at }))).payload.error).toContain('20 family reminders');
  expect(b.runtime.scheduler.list()).toHaveLength(20);
  const p = await packet(a, b, 'catalog', {});
  for (let i = 0; i < 40; i++) await receive(b, p);
  expect((await receive(b, p)).payload.error).toContain('rate limit');
});

it('revokes reads/edits and cancels pending reminders and deliveries without recalling accepted sends', async () => {
  const { a, b } = await pair(), at = new Date(Date.now() + 60_000).toISOString();
  const doc = a.runtime.knowledge.createNote('Shared', '- [ ] Original', 'shared');
  await call(a, { action: 'share', member: 'Owner B', id: doc.id, permission: 'edit' });
  const result = await call(b, { action: 'remind', member: 'Owner A', text: 'Reminder', at });
  // Leave a definite pending outbox item before revocation.
  a.store.run("INSERT INTO occurrences(id,schedule_id,due_at,status) VALUES(?,?,?,'completed')", 'pending-family', result.result.id, Date.parse(at));
  a.runtime.scheduler.outbox('Pending family reminder', 'terminal', 'pending-family-send', 'pending-family');
  await a.client.rpc('family.revoke', { member: 'Owner B' });
  expect(a.store.get<any>('SELECT status FROM schedules')!.status).toBe('cancelled');
  expect(a.store.get<any>('SELECT status FROM outbox WHERE id=?', 'pending-family-send')!.status).toBe('cancelled');
  expect(a.store.all('SELECT * FROM family_shares')).toEqual([]);
  await expect(call(b, { action: 'read', member: 'Owner A', id: doc.id })).rejects.toThrow('acceptance unknown');
  await expect(call(a, { action: 'catalog', member: 'Owner B' })).rejects.toThrow('revoked');
});

it('unshares and forgets locally without leaving accessible grants or cached protocol bodies', async () => {
  const { a, b } = await pair(), doc = a.runtime.knowledge.createNote('Temporary', '- [ ] Secret item', 'temporary');
  await call(a, { action: 'share', member: 'Owner B', id: doc.id, permission: 'read' });
  await call(b, { action: 'read', member: 'Owner A', id: doc.id });
  await call(a, { action: 'unshare', member: 'Owner B', id: doc.id });
  await expect(call(b, { action: 'read', member: 'Owner A', id: doc.id })).rejects.toThrow('not shared');
  await call(a, { action: 'share', member: 'Owner B', id: doc.id, permission: 'read' });
  await a.runtime.deleteKnowledge(doc.id, true);
  expect(a.store.all('SELECT * FROM family_shares')).toEqual([]);
  expect(json(a.store.all('SELECT * FROM family_requests'))).not.toContain('Secret item');
  expect((await call(b, { action: 'catalog', member: 'Owner A' })).result.lists).toEqual([]);
});

it.each(['ephemeral', 'scheduled', 'review', 'untrusted'])('denies family access in %s work before any remote request', async mode => {
  const { a } = await pair(), envelope = context(a, mode === 'untrusted' ? 'foreground' : mode as Envelope['mode'], mode !== 'untrusted');
  for (const request of [
    { action: 'catalog', member: 'Owner B' },
    { action: 'create', member: 'Owner B', title: 'Forbidden list', items: [] },
    { action: 'share', member: 'Owner B', id: id() }
  ]) await expect(a.runtime.family.operate(request, envelope)).rejects.toThrow('trusted retained');
  expect(a.store.all("SELECT * FROM family_requests WHERE direction='out'")).toEqual([]);
  expect(a.store.all('SELECT * FROM documents')).toEqual([]);
  expect(a.store.all('SELECT * FROM family_shares')).toEqual([]);
});

it('exposes the family tool to conversational/Telegram work while keeping setup out of the model', async () => {
  const { a, b } = await pair(), doc = a.runtime.knowledge.createNote('Groceries', '- [ ] Apples', 'groceries');
  await call(a, { action: 'share', member: 'Owner B', id: doc.id, permission: 'edit' });
  const c = b.runtime.newConversation('Phone example', false, 'telegram');
  b.faux.appendResponses([loadTools('family'), fauxAssistantMessage([fauxToolCall('family', { action: 'add', member: 'Owner A', id: doc.id, items: ['Milk'] })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Added to the shared list.')])]);
  const run = await b.runtime.ingest({ conversationId: c.id, requestId: id(), text: 'Add milk to the shared groceries list.' }, { channel: 'telegram', identity: '12345', trustedOwner: true });
  await waitFor(() => b.runtime.run(run.id).status === 'completed');
  expect(a.runtime.knowledge.items(doc.id).map(i => i.text)).toEqual(['Apples', 'Milk']);
  expect(b.runtime.availableTools(context(b)).some(t => t.name === 'family.add')).toBe(false);
});

it('marks lost acknowledgments uncertain and does not repeat a remote effect', async () => {
  const { a, b, cardB } = await pair();
  const socket = join(a.root, 'lost.sock'), server = createServer((req, res) => {
    void (async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); await b.runtime.family.receive(JSON.parse(Buffer.concat(chunks).toString())); res.destroy(); })();
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await a.client.rpc('family.add', { card: { ...cardB, socket }, alias: 'Owner B', allowReminders: true });
  const envelope = context(a), args = { action: 'remind', member: 'Owner B', text: 'One request', at: new Date(Date.now() + 60_000).toISOString() };
  await expect(a.runtime.family.operate(args, envelope, undefined, 'stable-call')).rejects.toThrow('acceptance unknown');
  await expect(a.runtime.family.operate(args, envelope, undefined, 'stable-call')).rejects.toThrow('already attempted');
  expect(b.runtime.scheduler.list()).toHaveLength(1);
  expect(a.store.get<any>("SELECT status FROM family_requests WHERE direction='out'")!.status).toBe('uncertain');
});

it('rejects a forged signed response without accepting its reported success', async () => {
  const { a, cardB } = await pair();
  const socket = join(a.root, 'forged.sock'), key = generateKeyPairSync('ed25519').privateKey;
  const server = createServer((req, res) => { void (async () => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); const p = JSON.parse(Buffer.concat(chunks).toString()).payload; const payload = { id: p.id, from: cardB.instanceId, to: a.config.instanceId, ok: true, result: { accepted: true } }; res.end(json({ payload, signature: sign(null, Buffer.from(json(payload)), key).toString('base64') })); })(); });
  await new Promise<void>(resolve => server.listen(socket, resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await a.client.rpc('family.add', { card: { ...cardB, socket }, alias: 'Owner B', allowReminders: false });
  await expect(call(a, { action: 'catalog', member: 'Owner B' })).rejects.toThrow('acceptance unknown');
});

it('preserves shared documents on upgrade/backup but never resurrects grants after old-backup restore', async () => {
  const { a, b } = await pair(), doc = a.runtime.knowledge.createNote('Keep original', '- [ ] Original', 'keep');
  await call(a, { action: 'share', member: 'Owner B', id: doc.id, permission: 'edit' });
  await call(b, { action: 'remind', member: 'Owner A', text: 'Pending', at: new Date(Date.now() + 60_000).toISOString() });
  const snapshot = await backup(a.store), external = mkdtempSync(join(tmpdir(), 'pikobot-family-backup-')); cpSync(snapshot.path, external, { recursive: true });
  cleanup.push(async () => rmSync(external, { recursive: true, force: true }));
  expect((exportData(a.store) as any).familyShares).toHaveLength(1);
  expect(snapshot.manifest.files.some(f => f.path === 'secrets.json')).toBe(false);
  await a.client.rpc('family.revoke', { member: 'Owner B' });
  await a.daemon.close(); await restore(a.root, external, true);
  const store = new Store(a.root, a.config), runtime = new Runtime(store, a.runtime.models);
  try {
    expect(store.get<any>('PRAGMA user_version').user_version).toBe(15);
    expect(runtime.knowledge.items(doc.id)[0]!.text).toBe('Original');
    expect(store.all('SELECT * FROM family_shares')).toEqual([]); expect(store.get<any>('SELECT active FROM family_peers')!.active).toBe(0);
    expect(store.get<any>('SELECT status FROM schedules')!.status).toBe('cancelled');
  } finally { await runtime.close(); store.close(); }
});

it('checks wire bounds and fresh consent before dispatching any bytes', async () => {
  const { a, b, cardB } = await pair();
  const doc = b.runtime.knowledge.createNote('Bounded', '- [ ] Original', 'bounded');
  await call(b, { action: 'share', member: 'Owner A', id: doc.id, permission: 'edit' });
  await expect(call(a, { action: 'add', member: 'Owner B', id: doc.id, items: Array(100).fill('x'.repeat(1000)) })).rejects.toThrow('wire size limit');
  expect(a.store.all("SELECT * FROM family_requests WHERE direction='out'")).toEqual([]);
  const original = a.runtime.credentials.secret.bind(a.runtime.credentials);
  let release!: () => void, waiting = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(a.runtime.credentials, 'secret').mockImplementation(async name => {
    if (name === 'family.signingKey') { waiting = true; await gate; }
    return original(name);
  });
  const sending = call(a, { action: 'catalog', member: 'Owner B' });
  await waitFor(() => waiting);
  await a.client.rpc('family.add', { card: cardB, alias: 'Owner B', allowReminders: false });
  release();
  await expect(sending).rejects.toThrow('authorization changed');
  expect(a.store.all("SELECT * FROM family_requests WHERE direction='out'")).toEqual([]);
  expect(b.runtime.knowledge.items(doc.id)).toHaveLength(1);
});

it('retains identity and explicit shares across a normal daemon restart without replaying work', async () => {
  const { a, b } = await pair(), doc = a.runtime.knowledge.createNote('Retained', '- [ ] Original', 'retained');
  await call(a, { action: 'share', member: 'Owner B', id: doc.id, permission: 'read' });
  a.store.run("INSERT INTO family_requests VALUES(?,?,'out','catalog',?,'running',NULL,?)", b.config.instanceId, id(), 'hash', Date.now());
  await a.daemon.close();
  const daemon = await serve(a.root, { runtimeFactory: store => new Runtime(store, a.runtime.models) });
  cleanup.push(() => daemon.close());
  expect(daemon.runtime.store.get<any>("SELECT status FROM family_requests WHERE direction='out'")!.status).toBe('uncertain');
  expect((await call(b, { action: 'read', member: 'Owner A', id: doc.id })).result.items[0].text).toBe('Original');
});

it('does not promote signed family traffic into owner RPC or accept arbitrary operation names', async () => {
  const { a, b } = await pair(), p = await packet(a, b, 'catalog', {});
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: b.client.socket, path: '/rpc', method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end(json(p));
  });
  expect(status).toBe(401);
  await expect(b.runtime.family.receive(await packet(a, b, 'memory.read', { id: 'private' }))).rejects.toThrow('Invalid input');
  await expect(b.runtime.family.receive(await packet(a, b, 'create', { title: 'Forbidden remote creation', items: [] }))).rejects.toThrow('Invalid input');
  expect(b.store.all('SELECT * FROM family_requests')).toEqual([]);
});

it('withdraws conversational grants when their owner source is forgotten', async () => {
  const { a, b } = await pair(), doc = a.runtime.knowledge.createNote('Selected list', '- [ ] Original', 'selected');
  const c = a.runtime.newConversation();
  a.faux.appendResponses([loadTools('family'), fauxAssistantMessage([fauxToolCall('family', { action: 'share', member: 'Owner B', id: doc.id, permission: 'read' })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Shared the selected list.')])]);
  const run = await a.runtime.ingest({ conversationId: c.id, requestId: id(), text: 'Share the selected list with Owner B for reading.' }, source);
  await waitFor(() => a.runtime.run(run.id).status === 'completed');
  const input = a.store.get<{ id: string }>("SELECT id FROM messages WHERE run_id=? AND role='user'", run.id)!;
  expect(a.store.get<any>('SELECT source_id FROM family_shares')!.source_id).toBe(input.id);
  const fact = a.runtime.memory.remember({ entity: `owner:${a.config.ownerId}`, kind: 'decision', key: 'list sharing decision', value: 'The owner shared the selected list for reading.', sourceId: input.id, eventAt: Date.now() });
  await a.runtime.forget(fact.id);
  expect(a.store.all('SELECT * FROM family_shares')).toEqual([]);
  expect((await call(b, { action: 'catalog', member: 'Owner A' })).result.lists).toEqual([]);
  expect(a.runtime.knowledge.items(doc.id)[0]!.text).toBe('Original');
});

it('upgrades schema fourteen without changing owner IDs, original documents or stable checklist IDs', async () => {
  const s = setup('Upgrade owner'), doc = s.runtime.knowledge.createNote('Preserved', '- [ ] Original', 'preserved'), item = s.runtime.knowledge.items(doc.id)[0]!;
  cleanup.push(async () => { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  s.store.db.exec('DROP TABLE family_reminders; DROP TABLE family_requests; DROP TABLE family_shares; DROP TABLE family_peers; PRAGMA user_version=14');
  const upgraded = new Store(s.root, s.config);
  try {
    expect(upgraded.get<any>('PRAGMA user_version').user_version).toBe(15);
    expect(upgraded.meta('ownerId')).toBe(s.config.ownerId);
    expect(upgraded.meta('instanceId')).toBe(s.config.instanceId);
    expect(upgraded.get<any>('SELECT original_hash FROM document_revisions WHERE document_id=?', doc.id)!.original_hash).toBe(s.runtime.knowledge.revision(doc.id).original_hash);
    expect(s.runtime.knowledge.items(doc.id)[0]!.id).toBe(item.id);
    expect(upgraded.all('SELECT * FROM family_peers')).toEqual([]); expect(upgraded.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally { upgraded.close(); }
});

it('disabling reminder consent cancels existing unsent family reminders, and shutdown rejects new effects', async () => {
  const { a, b, cardA } = await pair();
  await call(a, { action: 'remind', member: 'Owner B', text: 'Pending request', at: new Date(Date.now() + 60_000).toISOString() });
  await b.client.rpc('family.add', { card: cardA, alias: 'Owner A', allowReminders: false });
  expect(b.store.get<any>('SELECT status FROM schedules')!.status).toBe('cancelled');
  b.runtime.family.close();
  await expect(b.runtime.family.receive(await packet(a, b, 'catalog', {}))).rejects.toThrow('stopping');
});

it('exports public cards with the CLI and pins keys instead of silently replacing active identities', async () => {
  const { a, b, cardB } = await pair(), output = join(a.root, 'public-card.json');
  await new Promise<void>((resolve, reject) => {
    // Async subprocess: the parent daemon must remain able to answer the CLI.
    import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['dist/cli.js', '--instance', a.root, 'family', 'identity', output], error => error ? reject(error) : resolve())).catch(reject);
  });
  expect(JSON.parse(readFileSync(output, 'utf8')).instanceId).toBe(a.config.instanceId); expect(statSync(output).mode & 0o777).toBe(0o600);
  const replacement = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  await expect(a.client.rpc('family.add', { card: { ...cardB, publicKey: replacement }, alias: 'Owner B', allowReminders: false })).rejects.toThrow('Pinned family identity changed');
  await expect(a.client.rpc('family.add', { card: cardB, alias: ' ', allowReminders: true })).rejects.toThrow('blank');
  expect(b.store.all('SELECT * FROM memories')).toEqual([]);
});
