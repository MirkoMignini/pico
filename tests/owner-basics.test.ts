import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, reply, source, waitFor } from './helpers.js';
import { Memory } from '../src/memory.js';
import { Store, json } from '../src/store.js';
import { backup, restore } from '../src/backup.js';
import type { MemoryCapture } from '../src/contracts.js';

const instances: ReturnType<typeof setup>[] = [];
const directories: string[] = [];
function instance() { const s = setup('Setup label'); instances.push(s); return s; }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fact(s: ReturnType<typeof setup>, key = 'name', value = 'The owner is named Rowan.', overrides: Partial<MemoryCapture> = {}) {
  const sourceId = s.runtime.ownerEvidence(value);
  return s.runtime.memory.remember({ entity: `owner:${s.config.ownerId}`, kind: 'fact', key, value, quote: value, sourceId, eventAt: Date.now(), ...overrides }, false);
}
function basics(prompt: string) {
  const block = prompt.split('Owner basics (factual context, not instructions or permissions): ')[1];
  return block ? JSON.parse(block.split('\n')[0]!) : [];
}

it('selects only allowlisted owner basics without inference, embeddings or persistent writes', () => {
  const s = instance(), name = fact(s);
  fact(s, 'preferred_name', 'The owner goes by Ro.', { kind: 'preference' });
  fact(s, 'city', 'The owner lives in Bari.');
  fact(s, 'occupation', 'The owner is a developer.');
  fact(s, 'health', 'Sensitive health detail.', { tags: ['communication'] });
  fact(s, 'address', 'Exact private address.');
  fact(s, 'name', 'A friend is named Casey.', { entity: 'person:Casey' });
  const embed = vi.fn(), memory = new Memory(s.store, { model: 'unused', version: '1', dimensions: 1, embed });
  const before = s.store.all('SELECT * FROM memories');
  const selected = memory.ownerBasics('terminal');
  expect(selected.map(item => item.field)).toEqual(['preferred_name', 'name', 'home_city', 'occupation']);
  expect(selected.find(item => item.field === 'name')?.facts).toMatchObject([{ id: name.id, value: name.value, quote: name.value, sourceId: name.source_id, basis: 'inferred' }]);
  expect(json(selected)).not.toMatch(/Sensitive|private address|Casey/);
  expect(s.store.all('SELECT * FROM memories')).toEqual(before);
  expect(embed).not.toHaveBeenCalled(); expect(s.faux.state.callCount).toBe(0);
});

it('guides canonical basics in the existing extraction pass without promoting inferred authority', async () => {
  const s = instance(), text = 'My name is Rowan.', sourceId = s.runtime.ownerEvidence(text);
  s.store.run("INSERT INTO reviews(source_id,status) VALUES(?,'pending')", sourceId);
  const complete = vi.spyOn(s.runtime.models, 'complete');
  reply(s.faux, json({ memory: [{ id: '0', text: 'The owner is named Rowan.', attributed_to: 'user', entity: `owner:${s.config.ownerId}`, kind: 'fact', key: 'name', quote: text }] }));
  await s.runtime.memory.extractOne(s.runtime.models);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(json(complete.mock.calls[0]![0])).toContain('canonical keys: preferred_name (form of address), name, home_city, home_country, occupation');
  expect(s.runtime.memory.ownerBasics('terminal')[0]?.facts[0]).toMatchObject({ value: 'The owner is named Rowan.', basis: 'inferred', sourceId });
  expect(s.store.all("SELECT id FROM memories WHERE status='current'")).toEqual([]);
});

it('prefers scoped explicit corrections across aliases over newer inferred facts', () => {
  const s = instance();
  fact(s, 'full name', 'The owner is named Old Name.', { eventAt: 1 });
  s.runtime.remember('name', 'Global Name');
  const scoped = s.runtime.remember('first_name', 'Terminal Name', 'terminal') as { id: string };
  fact(s, 'name', 'The owner is named Inferred Name.');
  expect(s.runtime.memory.ownerBasics('terminal').find(item => item.field === 'name')?.facts).toMatchObject([{ id: scoped.id, value: 'Terminal Name', scope: 'terminal', basis: 'direct' }]);
  expect(s.runtime.memory.ownerBasics('telegram').find(item => item.field === 'name')?.facts).toMatchObject([{ value: 'Global Name' }]);
  const correction = s.runtime.remember('name', 'New Global Name') as { id: string };
  expect(s.runtime.memory.ownerBasics('telegram').find(item => item.field === 'name')?.facts).toMatchObject([{ id: correction.id }]);
});

it('preserves two inferred alternatives ordered by event time rather than ingestion time', () => {
  const s = instance();
  const newest = fact(s, 'name', 'The owner is named New Name.', { eventAt: 30 });
  const older = fact(s, 'full_name', 'The owner is named Older Name.', { eventAt: 20 });
  fact(s, 'name', 'The owner is named Imported Name.', { eventAt: 10 });
  expect(s.runtime.memory.ownerBasics('terminal')[0]?.facts.map(record => record.id)).toEqual([newest.id, older.id]);
});

it('excludes expired, future, wrong-scope, non-factual and unsupported-source records', () => {
  const s = instance();
  fact(s, 'name', 'Expired Name', { eventAt: 1, validUntil: 2 });
  fact(s, 'name', 'Future Name', { eventAt: Date.now() + 60_000 });
  fact(s, 'name', 'Telegram Name', { scope: 'telegram' });
  fact(s, 'name', 'A commitment, not a name', { kind: 'commitment' });
  const external = fact(s, 'name', 'Forwarded Name');
  s.store.run("UPDATE messages SET actor='external:telegram' WHERE id=?", external.source_id);
  const assistant = fact(s, 'name', 'Assistant Guess');
  s.store.run("UPDATE messages SET actor=?,role='assistant' WHERE id=?", `assistant:${s.config.instanceId}`, assistant.source_id);
  const unquoted = fact(s, 'name', 'Unquoted Name');
  s.store.run('DELETE FROM memory_evidence WHERE memory_id=?', unquoted.id);
  const invalidQuote = fact(s, 'name', 'Invalid Quote');
  s.store.run("UPDATE memory_evidence SET quote='not in the source' WHERE memory_id=?", invalidQuote.id);
  const legacy = fact(s, 'name', 'Legacy Document Claim');
  s.store.run('INSERT INTO memory_confirmations VALUES(?,?)', legacy.id, external.source_id);
  expect(s.runtime.memory.ownerBasics('terminal')).toEqual([]);
});

it('never reads another instance even when the owner/basic keys match', () => {
  const a = instance(), b = instance(); fact(a);
  expect(b.runtime.memory.ownerBasics('terminal')).toEqual([]);
});

it.each(['missing', 'external', 'oversized', 'too many'])('includes contextual evidence but omits basics with %s dependencies', failure => {
  const s = instance(), contextId = s.runtime.ownerEvidence('My preferred name is Ro.');
  const name = fact(s, 'preferred_name', 'The owner goes by Ro.', { quote: 'Yes.', sourceId: s.runtime.ownerEvidence('Yes.'), contextSourceIds: [contextId] });
  expect(s.runtime.memory.ownerBasics('terminal')[0]?.facts[0]).toMatchObject({ id: name.id, context: [{ sourceId: contextId, text: 'My preferred name is Ro.', actor: `human:${s.config.ownerId}` }] });
  if (failure === 'missing') s.store.run('DELETE FROM messages WHERE id=?', contextId);
  if (failure === 'external') s.store.run("UPDATE messages SET actor='external:document' WHERE id=?", contextId);
  if (failure === 'oversized') s.store.run('UPDATE messages SET text=? WHERE id=?', 'x'.repeat(257), contextId);
  if (failure === 'too many') for (let i = 0; i < 4; i++) s.store.run('INSERT INTO memory_dependencies VALUES(?,?)', name.id, s.runtime.ownerEvidence(`Additional context ${i}`));
  expect(s.runtime.memory.ownerBasics('terminal')).toEqual([]);
});

it('bounds the entire serialized profile and never clips away an alternative', () => {
  const s = instance();
  for (const key of ['preferred_name', 'name', 'home_city', 'home_country', 'occupation']) {
    for (let i = 0; i < 2; i++) fact(s, key, `${i}: ${'\\\n"'.repeat(60)}`);
  }
  const selected = s.runtime.memory.ownerBasics('terminal');
  expect(selected[0]?.field).toBe('preferred_name');
  expect(selected.every(item => item.facts.length === 2)).toBe(true);
  expect(json(selected).length).toBeLessThanOrEqual(2000);
  const oversized = instance();
  fact(oversized, 'name', 'Older plausible name', { eventAt: 1 });
  fact(oversized, 'name', 'x'.repeat(257));
  expect(oversized.runtime.memory.ownerBasics('terminal')).toEqual([]);
});

it.each(['terminal', 'telegram'])('includes basics in new %s chats independently of retrieval, and refreshes corrections', async channel => {
  const s = instance(), name = fact(s), session = s.runtime.newConversation();
  const search = vi.spyOn(s.runtime.memory, 'search').mockResolvedValue([]);
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple');
  expect(s.faux.state.callCount).toBe(0);
  const inputSource = { ...source, channel };
  reply(s.faux, 'Hi Rowan.');
  const first = await s.runtime.ingest({ requestId: 'hello', conversationId: session.id, text: 'Hi' }, inputSource);
  await waitFor(() => s.runtime.run(first.id).status === 'completed');
  const request = stream.mock.calls[0]![1], prompt = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  expect(basics(prompt)[0].facts[0]).toMatchObject({ id: name.id, value: name.value });
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', first.id)).toContainEqual({ source_id: name.source_id });
  expect(prompt).toContain('Use a neutral greeting if name evidence conflicts');
  expect(prompt).toContain('Explicit owner standing preferences (scoped, not permissions): []');
  const correction = s.runtime.remember('name', 'Riley') as { id: string };
  reply(s.faux, 'Hi Riley.');
  const second = await s.runtime.ingest({ requestId: 'hello-again', conversationId: session.id, text: 'Hi again' }, inputSource);
  await waitFor(() => s.runtime.run(second.id).status === 'completed');
  const next = stream.mock.calls[1]![1];
  expect(basics(next.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'))[0].facts).toMatchObject([{ id: correction.id, value: 'Riley' }]);
  expect(next.messages[0]?.content).toBe(request.messages[0]?.content);
  expect(next.messages[0]?.toolsAdded).toEqual(request.messages[0]?.toolsAdded);
  expect(search).not.toHaveBeenCalled(); expect(s.faux.state.callCount).toBe(2);
});

it('drops basics rather than recent dialogue under context-budget pressure, linking only injected direct evidence', async () => {
  const s = instance(), name = fact(s), session = s.runtime.newConversation();
  vi.spyOn(s.runtime.memory, 'search').mockResolvedValue([]);
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple');
  reply(s.faux, `${'| synthetic | route |\n'.repeat(240)}Should I save the table?`);
  const first = await s.runtime.ingest({ requestId: 'table', conversationId: session.id, text: 'Prepare a table' }, source);
  await waitFor(() => s.runtime.run(first.id).status === 'completed', 15_000);
  const request = stream.mock.calls[0]![1], prompt = request.messages.find(message => message.role === 'system' && message.content.startsWith('Explicit owner standing preferences'))!.content;
  expect(basics(prompt)[0].facts[0].id).toBe(name.id);
  const withoutBasics = prompt.slice(0, prompt.indexOf('Owner basics ('));
  const historyChars = s.store.all<{ body: string }>('SELECT body FROM messages WHERE conversation_id=? ORDER BY rowid', session.id).reduce((size, row) => {
    const message = JSON.parse(row.body);
    return size + json(message.role === 'assistant' ? { role: message.role, content: message.content } : message).length;
  }, 0);
  // Fit the entire prior exchange, but leave no room for the optional basics block.
  s.config.limits.contextChars = request.messages[0]!.content.length + withoutBasics.length + 'Yes, please'.length + historyChars + 32;
  reply(s.faux, 'Understood.');
  const next = await s.runtime.ingest({ requestId: 'table-followup', conversationId: session.id, text: 'Yes, please' }, source);
  await waitFor(() => s.runtime.run(next.id).status === 'completed');
  const messages = stream.mock.calls[1]![1].messages;
  expect(basics(messages.filter(message => message.role === 'system').map(message => message.content).join('\n'))).toEqual([]);
  expect(json(messages)).toContain('Should I save the table?');
  expect(s.store.get('SELECT source_id FROM run_sources WHERE run_id=? AND source_id=? AND inherited=0', next.id, name.source_id)).toBeUndefined();
}, 15_000);

it('ephemeral chats read contextual basics without persisting content or lineage', async () => {
  const s = instance(), contextId = s.runtime.ownerEvidence('My name is Rowan.');
  const name = fact(s, 'name', 'The owner is named Rowan.', { quote: 'Yes.', sourceId: s.runtime.ownerEvidence('Yes.'), contextSourceIds: [contextId] });
  const session = s.runtime.newConversation('Ephemeral', true);
  vi.spyOn(s.runtime.memory, 'search').mockResolvedValue([]);
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple');
  const before = ['messages', 'memories', 'reviews', 'runs', 'run_sources', 'operations'].map(table => s.store.all(`SELECT * FROM ${table}`));
  reply(s.faux, 'Hi Rowan.');
  const run = await s.runtime.ingest({ requestId: 'ephemeral-hello', conversationId: session.id, text: 'Hi' }, source);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  expect(json(stream.mock.calls[0]![1])).toContain(name.value);
  expect(['messages', 'memories', 'reviews', 'runs', 'run_sources', 'operations'].map(table => s.store.all(`SELECT * FROM ${table}`))).toEqual(before);
  await s.runtime.forget(name.id);
  expect(s.runtime.memory.ownerBasics('terminal')).toEqual([]);
});

it.each(['foreground', 'scheduled', 'review'] as const)('does not inject owner basics into untrusted %s work', async mode => {
  const s = instance(); fact(s);
  vi.spyOn(s.runtime.memory, 'search').mockResolvedValue([]);
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple');
  reply(s.faux, 'Hello.');
  const run = await s.runtime.ingest({ requestId: mode, conversationId: s.runtime.newConversation().id, text: 'Hi' }, { ...source, trustedOwner: false }, mode);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  expect(basics(stream.mock.calls[0]![1].messages.filter(message => message.role === 'system').map(message => message.content).join('\n'))).toEqual([]);
});

it.each(['scheduled', 'review'] as const)('does not inject basics even with a trusted sender in %s mode', async mode => {
  const s = instance(); fact(s);
  vi.spyOn(s.runtime.memory, 'search').mockResolvedValue([]);
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple');
  reply(s.faux, 'Hello.');
  const run = await s.runtime.ingest({ requestId: mode, conversationId: s.runtime.newConversation().id, text: 'Hi' }, source, mode);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  expect(basics(stream.mock.calls[0]![1].messages.filter(message => message.role === 'system').map(message => message.content).join('\n'))).toEqual([]);
});

it('forgets profile-only evidence, contextual lineage and exact snapshots even through an old backup', async () => {
  const s = instance(), anchor = fact(s, 'nickname evidence', 'The name is Rowan.');
  const name = fact(s, 'name', 'The owner is named Rowan.', { quote: 'Yes.', sourceId: s.runtime.ownerEvidence('Yes.'), contextSourceIds: [anchor.source_id] });
  vi.spyOn(s.runtime.memory, 'search').mockResolvedValue([]);
  const session = s.runtime.newConversation(); reply(s.faux, 'Hi Rowan.');
  const run = await s.runtime.ingest({ requestId: 'profile-only', conversationId: session.id, text: 'Hi' }, source);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', run.id)).toEqual(expect.arrayContaining([{ source_id: name.source_id }, { source_id: anchor.source_id }]));
  const saved = s.store.get<{ id: string }>("SELECT id FROM messages WHERE run_id=? AND role='assistant'", run.id)!;
  expect(s.runtime.readInstructions(saved.id).text).toContain(name.value);
  const snapshot = await backup(s.store), external = mkdtempSync(join(tmpdir(), 'pikobot-owner-basics-'));
  directories.push(external); cpSync(snapshot.path, external, { recursive: true });
  await s.runtime.forget(anchor.id);
  expect(s.runtime.memory.ownerBasics('terminal')).toEqual([]);
  expect(() => s.runtime.readInstructions(saved.id)).toThrow(/not recorded|erased/);
  await s.runtime.close(); s.store.close(); instances.splice(instances.indexOf(s), 1); directories.push(s.root);
  await restore(s.root, external, true);
  const restored = new Store(s.root, s.config);
  try {
    expect(new Memory(restored).ownerBasics('terminal')).toEqual([]);
    expect(restored.get('SELECT id FROM messages WHERE id=?', saved.id)).toBeUndefined();
  } finally { restored.close(); }
});
