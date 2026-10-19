import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setup, reply, source, waitFor } from './helpers.js';
import { Memory } from '../src/memory.js';
import { Store, textChunks, json, hash } from '../src/store.js';
import { OpenaiEmbeddings } from '../src/media.js';
import { Mem0Operation } from '../src/mem0.js';
import { backup, restore, exportData } from '../src/backup.js';
import { rpc } from '../src/daemon.js';

const instances: ReturnType<typeof setup>[] = [];
const directories: string[] = [];
function instance() { const s = setup(); instances.push(s); return s; }
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function pending(s: ReturnType<typeof setup>, text: string) {
  const id = s.runtime.ownerEvidence(text); s.store.run("INSERT INTO reviews(source_id,status) VALUES(?,'pending')", id); return id;
}
function fact(s: ReturnType<typeof setup>, quote = 'My bike is jade.', overrides: Record<string, unknown> = {}) {
  return { id: '0', text: 'The owner has a jade bike.', attributed_to: 'user', entity: `owner:${s.config.ownerId}`, kind: 'fact', key: 'bike color', quote, ...overrides };
}
function extractReply(s: ReturnType<typeof setup>, facts: unknown[]) { reply(s.faux, json({ memory: facts })); }
function storedFact(s: ReturnType<typeof setup>, text: string, key = 'color', value = 'blue') {
  const sourceId = s.runtime.ownerEvidence(text);
  return s.runtime.memory.remember({ entity: `owner:${s.config.ownerId}`, kind: 'fact', key, value, quote: text, sourceId, eventAt: Date.now() }, false);
}
const embeddings = { model: 'fixture', dimensions: 2, version: '1', embed: async (texts: string[]) => texts.map(() => [1, 0]) };

it('extracts topic tags in the existing model pass and exposes authoritative metadata with quotes', async () => {
  const s = instance(), sourceId = pending(s, 'My bike is jade. My helmet is white.');
  const complete = vi.spyOn(s.runtime.models, 'complete');
  extractReply(s, [fact(s, undefined, { tags: ['hobbies', 'transport'] }), fact(s, 'My helmet is white.', { id: '1', key: 'helmet color', text: 'The owner has a white helmet.', tags: ['safety'] })]);
  await s.runtime.memory.extractOne(s.runtime.models);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(json(complete.mock.calls[0]![0])).toContain('Tags describe the fact, not its truth or authority');
  const records = s.runtime.memory.list();
  expect(records.find(record => record.key === 'bike color')?.tags).toEqual(['hobbies', 'transport']);
  expect(await rpc(s.runtime, { op: 'memory.tags' })).toEqual([{ tag: 'hobbies', count: 1 }, { tag: 'safety', count: 1 }, { tag: 'transport', count: 1 }]);
  const found = await rpc(s.runtime, { op: 'memory.search', args: { query: 'bike', tags: ['hobbies'], kind: 'fact', basis: 'inferred' } }) as any[];
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ sourceId, sourceActor: `human:${s.config.ownerId}`, facts: [{ key: 'bike color', basis: 'inferred', tags: ['hobbies', 'transport'], quote: 'My bike is jade.' }] });
  const payloads = s.store.all<{payload:string}>("SELECT payload FROM mem0_vectors WHERE collection='memories'").map(row => JSON.parse(row.payload));
  expect(payloads).toContainEqual(expect.objectContaining({ tags: ['hobbies', 'transport'], memoryKind: 'fact', scope: 'global', basis: 'inferred', status: 'stored' }));
  // Separate facts sharing one source cannot satisfy an all-tags filter together.
  expect(await s.runtime.memory.search('bike helmet', { tags: ['hobbies', 'safety'] })).toEqual([]);
});

it.each([false, true])('enforces tags/kind/basis before ranking and prevents raw-source or stale-metadata bypass (vectors=%s)', async vectors => {
  const s = instance(), inferred = storedFact(s, 'My canoe is cedar.', 'canoe', 'cedar');
  s.runtime.memory.tag({ id: inferred.id, tags: ['hobbies', 'travel'] });
  const direct = await rpc(s.runtime, { op: 'memory.remember', args: { key: 'canoe', value: 'mahogany', tags: ['travel'], kind: 'preference' } }) as any;
  const memory = vectors ? new Memory(s.store, embeddings) : s.runtime.memory;
  while (await memory.indexPending()) {}
  expect((await memory.search('canoe', { tags: ['hobbies', 'travel'], kind: 'fact', basis: 'inferred' })).map(row => row.sourceId)).toEqual([inferred.source_id]);
  expect((await memory.search('canoe', { tags: ['travel'], kind: 'preference', basis: 'direct' })).flatMap(row => row.facts).map(row => row!.id)).toEqual([direct.id]);
  expect(await memory.search('canoe', { tags: ['health'] })).toEqual([]);
  expect(await memory.search('canoe', { tags: ['travel'], basis: 'inferred', kind: 'preference' })).toEqual([]);
  expect(await rpc(s.runtime, { op: 'memory.list', args: { tags: ['hobbies'] } })).toMatchObject([{ id: inferred.id }]);
  expect(memory.read(inferred.id).memory.status).toBe('stored');
  const before = memory.read(inferred.id);
  const embed = vi.fn(embeddings.embed), racing = new Memory(s.store, { ...embeddings, embed: async texts => {
    s.runtime.memory.tag({ id: inferred.id, tags: ['home'] }); return embed(texts);
  } });
  expect(await racing.search('canoe', { tags: ['hobbies'] })).toEqual([]);
  expect(memory.read(inferred.id)).toEqual({ ...before, memory: { ...before.memory, tags: ['home'] } });
  expect(embed).toHaveBeenCalledTimes(1);
  const payload = s.store.get<{payload:string}>('SELECT payload FROM mem0_vectors WHERE record_id=?', inferred.id);
  if (vectors) expect(JSON.parse(payload!.payload).tags).toEqual(['home']);
  expect((exportData(s.store) as any).memoryTags).toContainEqual({ memory_id: inferred.id, tag: 'home' });
  s.runtime.memory.tag({ id: inferred.id, tags: [] });
  expect(memory.read(inferred.id).memory.tags).toEqual([]);
});

it('rejects malformed tags, unsupported metadata and foreign memories without partial writes', async () => {
  const s = instance(), other = instance(), record = storedFact(s, 'My canoe is cedar.', 'canoe', 'cedar');
  s.runtime.memory.tag({ id: record.id, tags: ['hobbies'] });
  for (const tags of [['Hobbies'], ['two words'], ['hobbies', 'hobbies'], ['x'.repeat(49)], Array.from({ length: 9 }, (_, i) => `tag-${i}`)]) {
    await expect(rpc(s.runtime, { op: 'memory.tag', args: { id: record.id, tags } })).rejects.toThrow('Invalid input');
    await expect(s.runtime.memory.search('canoe', { tags })).rejects.toThrow('Invalid input');
  }
  await expect(rpc(other.runtime, { op: 'memory.tag', args: { id: record.id, tags: ['travel'] } })).rejects.toThrow('not found');
  await expect(rpc(s.runtime, { op: 'memory.tag', args: { id: record.id, tags: [], basis: 'direct' } })).rejects.toThrow('Invalid input');
  await expect(rpc(s.runtime, { op: 'memory.search', args: { query: 'canoe', metadata: { ownerId: 'foreign' } } })).rejects.toThrow('Invalid input');
  expect(s.runtime.memory.read(record.id).memory.tags).toEqual(['hobbies']);
  expect(other.store.all('SELECT * FROM memory_tags')).toEqual([]);
});

it('does not leak superseded or expired facts attached to an otherwise eligible source', async () => {
  const s = instance(), sourceId = s.runtime.ownerEvidence('My city is Bari and I prefer tea.');
  const entity = `owner:${s.config.ownerId}`;
  const old = s.runtime.memory.remember({ entity, kind: 'fact', key: 'city', value: 'Bari', sourceId, eventAt: 1 });
  s.runtime.memory.remember({ entity, kind: 'fact', key: 'expired', value: 'expired badge', sourceId, eventAt: 1, validUntil: 2 });
  const preference = s.runtime.memory.remember({ entity, kind: 'preference', key: 'drink', value: 'tea', sourceId, eventAt: 1 });
  s.runtime.remember('city', 'Lecce');
  expect((await s.runtime.memory.search('tea')).find(row => row.sourceId === sourceId)?.facts).toMatchObject([{ id: preference.id }]);
  expect((await s.runtime.memory.search('tea', { history: true })).find(row => row.sourceId === sourceId)?.facts?.map(row => row.id)).toContain(old.id);
});

it('preserves tags through backup/restore and upgrades untagged schema-eight data without inference', async () => {
  const s = instance(), record = storedFact(s, 'My canoe is cedar.', 'canoe', 'cedar');
  s.runtime.memory.tag({ id: record.id, tags: ['hobbies', 'travel'] });
  const snapshot = await backup(s.store), external = mkdtempSync(join(tmpdir(), 'pikobot-memory-tags-')); directories.push(external);
  cpSync(snapshot.path, external, { recursive: true });
  await s.runtime.close(); s.store.close(); instances.splice(instances.indexOf(s), 1); directories.push(s.root);
  await restore(s.root, external, true);
  const restored = new Store(s.root, s.config);
  try { expect(new Memory(restored).read(record.id).memory.tags).toEqual(['hobbies', 'travel']); } finally { restored.close(); }
  const old = new DatabaseSync(join(external, 'pikobot.sqlite'));
  old.exec('DROP TABLE memory_tags; ALTER TABLE run_sources DROP COLUMN inherited; PRAGMA user_version=8'); old.close();
  writeFileSync(join(external, 'manifest.json'), json({ ...snapshot.manifest, files: snapshot.manifest.files.map(file => file.path === 'pikobot.sqlite' ? { ...file, hash: hash(readFileSync(join(external, file.path))) } : file) }));
  await restore(s.root, external, true);
  const upgraded = new Store(s.root, s.config);
  try {
    const memory = new Memory(upgraded);
    expect(memory.read(record.id).memory).toMatchObject({ ...record, tags: [] });
    expect(memory.read(record.id).support).toMatchObject({ source_id: record.source_id, quote: 'My canoe is cedar.' });
    expect(upgraded.get<any>('PRAGMA user_version').user_version).toBe(15);
    expect(upgraded.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(s.faux.state.callCount).toBe(0);
  } finally { upgraded.close(); }
});

it('runs real Mem0 OSS extraction and automatically stores sourced facts in the default memory list', async () => {
  const s = instance(), sourceId = pending(s, 'My bike is jade. My helmet is white.');
  const complete = vi.spyOn(s.runtime.models, 'complete');
  extractReply(s, [fact(s), fact(s, 'My helmet is white.', { id: '1', key: 'helmet color', text: 'The owner has a white helmet.' })]);
  await s.runtime.memory.extractOne(s.runtime.models);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]![0].systemPrompt).toContain('memory');
  expect(json(complete.mock.calls[0]![0])).toContain('Requests to create/edit a note or list describe intent, not successful storage or current saved contents');
  expect(s.runtime.memory.list()).toHaveLength(2);
  expect(s.runtime.memory.list()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'stored', basis: 'inferred', source_id: sourceId })]));
  expect(await rpc(s.runtime, { op: 'memory.list' })).toHaveLength(2);
  await expect(rpc(s.runtime, { op: 'memory.confirm', args: { id: s.runtime.memory.list()[0]!.id } })).rejects.toThrow('Unknown operation');
  await expect(rpc(s.runtime, { op: 'memory.list', args: { status: 'candidate' } })).rejects.toThrow('Invalid input');
  expect(s.store.all('SELECT * FROM memory_confirmations')).toEqual([]);
  const found = await s.runtime.memory.search('helmet', { entity: `owner:${s.config.ownerId}` });
  expect(found).toHaveLength(1); expect(found[0]?.sourceId).toBe(sourceId);
  expect(s.runtime.memory.read(found[0]!.facts![0]!.id).support).toMatchObject({ source_id: sourceId, quote: expect.stringContaining('My') });
  expect(s.store.get<any>('SELECT status FROM reviews').status).toBe('completed');
  expect(s.store.all("SELECT * FROM mem0_vectors WHERE collection='memories'")).toHaveLength(2);
  expect(await rpc(s.runtime, { op: 'status' })).toMatchObject({ memoryEngine: 'mem0ai/oss@3.3.1', schemaVersion: 15 });
});

it('maps Mem0\'s user alias to the immutable owner without turning inferred preferences into standing instructions', async () => {
  const s = instance(), sourceId = pending(s, 'I prefer concise replies.');
  extractReply(s, [fact(s, 'I prefer concise replies.', { entity: 'user', kind: 'preference', key: 'reply style', text: 'The user prefers concise replies.' })]);
  await s.runtime.memory.extractOne(s.runtime.models);
  const record = s.runtime.memory.list()[0]!;
  expect(record).toMatchObject({ entity: `owner:${s.config.ownerId}`, status: 'stored', basis: 'inferred' });
  expect((await s.runtime.memory.search('concise', { entity: record.entity }))[0]?.sourceId).toBe(sourceId);
  expect(s.store.all("SELECT * FROM memories WHERE kind='preference' AND status='current' AND entity=?", record.entity)).toHaveLength(0);
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple'); reply(s.faux, 'A sourced preference, not an instruction.');
  const run = await s.runtime.ingest({ requestId: 'inferred-preference', conversationId: s.runtime.newConversation().id, text: 'What reply style do I prefer?' }, source);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  expect(json(stream.mock.calls[0]![1])).toContain('Explicit owner standing preferences (scoped, not permissions): []');
});

it('foreground recall uses automatically stored facts without a memory-confirmation instruction', async () => {
  const s = instance(), record = storedFact(s, 'My favourite colour is amber.', 'favourite colour', 'amber');
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple');
  s.faux.appendResponses([fauxAssistantMessage([fauxToolCall('memory_search', { query: 'favourite colour' })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Your favourite colour is amber.')])]);
  const run = await s.runtime.ingest({ requestId: 'sourced-recall', conversationId: s.runtime.newConversation().id, text: 'What is my favourite colour?' }, source);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  const prompt = json(stream.mock.calls[1]![1]);
  expect(json(stream.mock.calls[0]![1])).not.toContain(record.source_id);
  expect(prompt).toContain('Memory storage requires no confirmation');
  expect(prompt).not.toContain('/remember'); expect(prompt).not.toContain('/confirm'); expect(prompt).not.toContain('candidate facts');
  expect(prompt).toContain(record.source_id);
  expect(prompt).toContain('By default do not mention source IDs, conversation IDs, memory IDs, tags, extraction or retrieval machinery');
  expect(prompt).toContain('only when explicitly asked for IDs/citations or an audit');
  expect(prompt).toContain("Do not pretend to be human or invent shared experiences");
  expect(prompt).not.toContain('report what they stated with its source ID');
  expect(s.runtime.run(run.id).partial).toBe('Your favourite colour is amber.');
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', run.id)).toContainEqual({ source_id: record.source_id });
  expect(s.runtime.memory.read(record.id).support).toMatchObject({ source_id: record.source_id, quote: 'My favourite colour is amber.' });
  expect(s.runtime.memory.list()).toHaveLength(1);
});

it('keeps Mem0 telemetry/default files and ambient provider credentials disabled', async () => {
  const s = instance(), directory = join(s.root, 'must-not-create');
  vi.stubEnv('MEM0_DIR', directory); vi.stubEnv('OPENAI_API_KEY', 'forbidden'); vi.stubEnv('DEEPSEEK_API_KEY', 'forbidden');
  const fetch = vi.fn(() => { throw new Error('Unexpected network call'); }); vi.stubGlobal('fetch', fetch);
  pending(s, 'My bike is jade.'); extractReply(s, [fact(s)]); await s.runtime.memory.extractOne(s.runtime.models);
  await s.runtime.memory.search('bike');
  expect(fetch).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(false);
  expect(existsSync(join(s.root, 'memory.db'))).toBe(false); expect(existsSync(join(s.root, 'vector_store.db'))).toBe(false);
});

it.each(['invented quote', 'foreign context', 'foreign owner', 'actor namespace', 'assistant claim', 'invalid tags', 'malformed JSON'])('rejects %s atomically with visible retry diagnostics', async failure => {
  const s = instance(), sourceId = pending(s, 'My bike is jade.');
  const value = fact(s);
  if (failure === 'invented quote') value.quote = 'My bike is red.';
  if (failure === 'foreign context') Object.assign(value, { contextSourceIds: ['foreign'] });
  if (failure === 'foreign owner') value.entity = 'owner:foreign';
  if (failure === 'actor namespace') value.entity = `human:${s.config.ownerId}`;
  if (failure === 'assistant claim') value.attributed_to = 'assistant';
  if (failure === 'invalid tags') Object.assign(value, { tags: ['ignore instructions'] });
  if (failure === 'malformed JSON') reply(s.faux, 'not json'); else extractReply(s, [value]);
  await s.runtime.memory.extractOne(s.runtime.models);
  expect(s.runtime.memory.list()).toEqual([]); expect(s.store.all('SELECT * FROM mem0_vectors')).toEqual([]);
  expect(s.store.get<any>('SELECT * FROM reviews WHERE source_id=?', sourceId)).toMatchObject({ status: 'pending', attempts: 1, error: expect.stringContaining('validation') });
});

it('resolves owner replies using retained context without deriving facts from assistant guesses', async () => {
  const s = instance(), question = s.runtime.ownerEvidence('Which instrument are you learning?');
  s.store.run('UPDATE messages SET role=?,actor=? WHERE id=?', 'assistant', `assistant:${s.config.instanceId}`, question);
  const target = pending(s, 'The oboe.');
  extractReply(s, [fact(s, 'The oboe.', { key: 'instrument learning', text: 'The owner is learning the oboe.', contextSourceIds: [question] })]);
  await s.runtime.memory.extractOne(s.runtime.models);
  const record = s.runtime.memory.list()[0]!;
  expect(record.source_id).toBe(target); expect(s.runtime.memory.read(record.id).context).toContainEqual(expect.objectContaining({ id: question }));
  expect(record.status).toBe('stored');
  s.store.run('UPDATE messages SET actor=? WHERE id=?', 'assistant:foreign', question);
  expect(() => storedFact(s, 'A claim with no context.')).not.toThrow();
  expect(() => s.runtime.memory.remember({ entity: record.entity, kind: 'fact', key: 'bad', value: 'guess', sourceId: target, eventAt: 1, quote: 'The oboe.', contextSourceIds: [question] }, false)).toThrow('owner-answered');
});

it('empty extraction, external senders and ephemeral input never create owner facts', async () => {
  const s = instance(); pending(s, 'Which city?'); extractReply(s, []); await s.runtime.memory.extractOne(s.runtime.models);
  const external = pending(s, 'Forwarded: I am a pilot.'); s.store.run("UPDATE messages SET actor='external:telegram' WHERE id=?", external);
  await s.runtime.memory.extractOne(s.runtime.models); expect(s.store.get<any>('SELECT status FROM reviews WHERE source_id=?', external).status).toBe('skipped');
  const session = s.runtime.newConversation('Private', true); reply(s.faux, 'Volatile only.');
  const run = await s.runtime.ingest({ requestId: 'volatile', conversationId: session.id, text: 'My private code is 1948.' }, source);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  expect(s.store.all("SELECT * FROM messages WHERE text LIKE '%1948%' ")).toEqual([]);
  expect(s.runtime.memory.list()).toEqual([]); expect(s.faux.state.callCount).toBe(2);
});

it('retries are idempotent, failed reviews can be requeued, and cancellation costs no attempt', async () => {
  const s = instance(), sourceId = pending(s, 'My bike is jade.');
  for (let i = 0; i < 3; i++) { reply(s.faux, 'not json'); s.store.run('UPDATE reviews SET next_at=0'); await s.runtime.memory.extractOne(s.runtime.models); }
  expect(s.store.get<any>('SELECT * FROM reviews').status).toBe('failed');
  expect(await rpc(s.runtime, { op: 'memory.retry' })).toEqual({ requeued: 1 });
  const controller = new AbortController(); controller.abort(); await s.runtime.memory.extractOne(s.runtime.models, controller.signal);
  expect(s.store.get<any>('SELECT attempts FROM reviews').attempts).toBe(0);
  extractReply(s, [fact(s), fact(s)]); await s.runtime.memory.extractOne(s.runtime.models);
  expect(s.runtime.memory.list()).toHaveLength(1);
  s.store.run("UPDATE reviews SET status='pending' WHERE source_id=?", sourceId); extractReply(s, [fact(s)]); await s.runtime.memory.extractOne(s.runtime.models);
  expect(s.runtime.memory.list()).toHaveLength(1);
});

it('extracts every long-message chunk, preserves the tail and rejects partial success', async () => {
  const s = instance(), text = 'Routine discussion. '.repeat(400) + 'My horse is named Clover.';
  const sourceId = pending(s, text), chunks = textChunks(text, 4000, 200);
  for (const chunk of chunks) extractReply(s, chunk.includes('Clover') ? [fact(s, 'My horse is named Clover.', { key: 'horse name', text: 'The owner has a horse named Clover.' })] : []);
  await s.runtime.memory.extractOne(s.runtime.models);
  expect(s.runtime.memory.list()).toMatchObject([{ source_id: sourceId, value: expect.stringContaining('Clover') }]);
  expect(s.faux.state.callCount).toBe(chunks.length);
  expect((await s.runtime.memory.search('Clover'))[0]?.text).toContain('Clover');
  expect(textChunks('😀'.repeat(2500)).every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  const broken = pending(s, text); extractReply(s, [fact(s, 'Routine discussion.', { text: 'A fact that must roll back.' })]); reply(s.faux, 'invalid');
  await s.runtime.memory.extractOne(s.runtime.models); expect(s.store.all('SELECT * FROM memories WHERE source_id=?', broken)).toEqual([]);
});

it('keeps owner assertions, historical, inferred and scoped evidence distinct and validates RPC filters', async () => {
  const s = instance(), old = s.runtime.remember('city', 'Ravenna') as any, current = s.runtime.remember('city', 'Ferrara') as any;
  storedFact(s, 'My city might be Padua.', 'city', 'possibly Padua');
  expect((await s.runtime.memory.search('city', { entity: old.entity })).map(r => r.id)).not.toContain(old.id);
  expect((await s.runtime.memory.search('Ravenna', { entity: old.entity, history: true })).map(r => r.id)).toContain(old.id);
  expect(s.runtime.memory.list('current')).toMatchObject([{ id: current.id }]);
  expect(s.runtime.memory.list()).toHaveLength(2);
  const expired = s.runtime.memory.remember({ entity: old.entity, kind: 'fact', key: 'badge', value: 'expired badge 993', sourceId: s.runtime.ownerEvidence('Badge expired.'), eventAt: 1, validUntil: 2 });
  expect(await s.runtime.memory.search('badge', { entity: old.entity })).toEqual([]);
  expect((await s.runtime.memory.search('badge', { entity: old.entity, history: true }))[0]?.id).toBe(expired.id);
  s.runtime.remember('style', 'brief', 'telegram', 'preference'); s.runtime.remember('style', 'detailed', 'terminal', 'preference');
  const scoped = await rpc(s.runtime, { op: 'memory.search', args: { query: 'style', scope: 'telegram' } }) as any[];
  expect(scoped.flatMap(r => r.facts).map(f => f.value)).toEqual(['brief']);
  await expect(rpc(s.runtime, { op: 'memory.search', args: { query: 'city', ownerId: 'foreign' } })).rejects.toThrow('Invalid input');
  await expect(s.runtime.memory.search('city', { since: 2, until: 1 })).rejects.toThrow('reversed');
  await expect(s.runtime.memory.search('city', { limit: 0 })).rejects.toThrow('Invalid input');
});

it('invalidates changed/stale embeddings, rejects incomplete batches and skips empty requests', async () => {
  const s = instance(), sourceId = s.runtime.ownerEvidence('Original text.'), embed = vi.fn(embeddings.embed);
  const memory = new Memory(s.store, { ...embeddings, embed });
  expect(await memory.indexPending()).toBe(1); expect(await memory.indexPending()).toBe(0); expect(embed).toHaveBeenCalledTimes(1);
  s.store.index({ id: sourceId, kind: 'message', text: 'Changed text.', sourceId, eventAt: Date.now() }); expect(s.store.all('SELECT * FROM mem0_vectors')).toEqual([]);
  embed.mockImplementationOnce(async () => { s.store.index({ id: sourceId, kind: 'message', text: 'Newer text.', sourceId, eventAt: Date.now() }); return [[1, 0]]; });
  await memory.indexPending(); expect(s.store.all('SELECT * FROM mem0_vectors')).toEqual([]);
  embed.mockImplementationOnce(async () => []); await expect(memory.indexPending()).rejects.toThrow('count mismatch');
});

it.each(['duplicate', 'missing', 'nonfinite', 'dimension'])('rejects %s OpenAI embeddings without another credential', async failure => {
  const s = instance(); await s.runtime.credentials.setSecret('openai.embeddingKey', 'synthetic-key');
  const data = [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }];
  if (failure === 'duplicate') data[1]!.index = 0;
  if (failure === 'missing') data.pop();
  if (failure === 'nonfinite') data[1]!.embedding = [Infinity, 0];
  if (failure === 'dimension') data[1]!.embedding = [1];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    expect((init.headers as any).Authorization).toBe('Bearer synthetic-key'); return new Response(json({ data }));
  });
  await expect(new OpenaiEmbeddings('text-embedding-3-small', 2, s.runtime.credentials).embed(['one', 'two'])).rejects.toThrow(/embedding|Embedding/);
});

it('forgets contextual descendants, entity boosts and derived schedules across backup/restore', async () => {
  const s = instance(), parent = storedFact(s, 'My friend Nora lives in Bari.', 'friend', 'Nora');
  s.runtime.memory.tag({ id: parent.id, tags: ['family'] });
  const childSource = s.runtime.ownerEvidence('She prefers Italian.'), child = s.runtime.memory.remember({ entity: 'person:nora', kind: 'preference', key: 'language', value: 'Italian', sourceId: childSource, eventAt: Date.now(), quote: 'She prefers Italian.', tags: ['communication'], contextSourceIds: [parent.source_id] }, false);
  const memory = new Memory(s.store, embeddings); while (await memory.indexPending()) {}
  s.store.run('INSERT INTO mem0_vectors VALUES(?,NULL,?,?,?,?,?,?)', 'entity', 'entities', embeddings.model, 2, '1', Buffer.from(new Float32Array([1, 0]).buffer), json({ user_id: s.config.ownerId, data: 'Nora' }));
  const schedule = s.runtime.scheduler.create({ text: 'Derived language instruction', timezone: 'Europe/Rome', at: new Date(Date.now() + 100000).toISOString(), kind: 'reminder', destination: 'terminal', misfire: 'once' }, 'fixture');
  s.store.run('INSERT INTO schedule_sources VALUES(?,?)', schedule.id, childSource);
  const snapshot = await backup(s.store), external = mkdtempSync(join(tmpdir(), 'pikobot-mem0-snapshot-')); directories.push(external); cpSync(snapshot.path, external, { recursive: true });
  await s.runtime.forget(parent.id);
  expect(() => s.runtime.memory.read(child.id)).toThrow('not found'); expect(s.runtime.memory.list()).toEqual([]);
  expect(s.runtime.memory.source(childSource)?.text).toBe('She prefers Italian.'); expect(s.runtime.scheduler.list()).toEqual([]);
  expect(s.store.all("SELECT * FROM mem0_vectors WHERE collection='entities'")).toEqual([]);
  expect((exportData(s.store) as any).memoryEvidence).toEqual([]);
  expect((exportData(s.store) as any).memoryTags).toEqual([]);
  await restore(s.root, external, true);
  const reopened = new Store(s.root, s.config); try {
    expect(reopened.all('SELECT * FROM memories')).toEqual([]); expect(reopened.all('SELECT * FROM memory_dependencies')).toEqual([]);
    expect(reopened.all('SELECT * FROM memory_tags')).toEqual([]);
    expect(reopened.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(reopened.all("SELECT * FROM mem0_vectors WHERE collection='entities'")).toEqual([]);
  } finally { reopened.close(); }
});

it('allows forgetting and WAL checkpoints while a large Mem0 scan yields without returning erased evidence', async () => {
  const s = instance(), record = storedFact(s, 'My private canoe is cedar.', 'canoe', 'cedar');
  for (let i = 0; i < 260; i++) s.runtime.ownerEvidence(`Synthetic archive entry ${i}`);
  const indexed = new Memory(s.store, embeddings); while (await indexed.indexPending()) {}
  let forgotten = false, failure: unknown;
  const memory = new Memory(s.store, { ...embeddings, embed: async texts => {
    setImmediate(() => { try { s.runtime.memory.forget(record.id); forgotten = true; } catch (error) { failure = error; } });
    return embeddings.embed(texts);
  } });
  const results = await memory.search('canoe');
  expect(failure).toBeUndefined(); expect(forgotten).toBe(true);
  expect(results.some(result => result.sourceId === record.source_id)).toBe(false);
  expect(s.runtime.memory.source(record.source_id)).toBeUndefined();
  expect(s.store.get('SELECT id FROM mem0_vectors WHERE record_id=?', record.id)).toBeUndefined();
});

it('streams large vector scans with cancellation and rechecks eligibility after asynchronous retrieval', async () => {
  const s = instance(), controller = new AbortController();
  for (let i = 0; i < 260; i++) s.runtime.ownerEvidence(`Synthetic archive fact ${i}`);
  const indexed = new Memory(s.store, embeddings); while (await indexed.indexPending()) {}
  const memory = new Memory(s.store, { ...embeddings, embed: async () => { setImmediate(() => controller.abort(new Error('Scan cancelled'))); return [[1, 0]]; } });
  await expect(memory.search('archive', { signal: controller.signal })).rejects.toThrow('Scan cancelled');
  const old = s.runtime.remember('city', 'Ravenna') as any;
  const racing = new Memory(s.store, { ...embeddings, embed: async () => { s.runtime.remember('city', 'Ferrara'); return [[1, 0]]; } });
  expect(await racing.search('Ravenna', { entity: old.entity })).toEqual([]);
});

it('retains lexical candidates\' real similarity when they fall outside Mem0\'s semantic shortlist', async () => {
  const s = instance(), memory = new Memory(s.store, embeddings);
  for (let i = 0; i < 260; i++) s.runtime.ownerEvidence(`Archive token-${i} has color blue.`);
  while (await memory.indexPending()) {}
  const expected = s.store.get<any>("SELECT id FROM messages WHERE text='Archive token-259 has color blue.'").id;
  expect((await memory.search('token-259'))[0]?.sourceId).toBe(expected);
});

it('never persists entity names whose linked memory was rejected or erased', () => {
  const s = instance(), operation = new Mem0Operation(s.store, embeddings);
  operation.staged.set('entity', { id: 'entity', collection: 'entities', vector: [1, 0], payload: { user_id: s.config.ownerId, data: 'Erased Name', linkedMemoryIds: ['missing-record'] } });
  operation.commit(); expect(s.store.all('SELECT * FROM mem0_vectors')).toEqual([]);
});

it('preserves literal Markdown fences in model facts without Mem0 rewriting validated JSON', async () => {
  const s = instance(), quote = 'My favourite literal marker is ```json.';
  pending(s, quote); extractReply(s, [fact(s, quote, { key: 'literal marker', text: 'The owner prefers the literal marker ```json.' })]);
  await s.runtime.memory.extractOne(s.runtime.models);
  expect(s.runtime.memory.list()[0]?.value).toBe('The owner prefers the literal marker ```json.');
});

it('migrates legacy candidates and restores schema-seven backups without losing provenance or resurrecting erased confirmation lineage', async () => {
  const s = instance(), record = storedFact(s, 'My town is Ancona.', 'town', 'Ancona');
  const legacy = s.runtime.remember('town', 'Ancona') as any;
  s.store.run('INSERT INTO memory_confirmations VALUES(?,?)', legacy.id, record.source_id);
  s.store.run('INSERT INTO memory_evidence SELECT ?,source_id,quote FROM memory_evidence WHERE memory_id=?', legacy.id, record.id);
  const context = s.runtime.ownerEvidence('Which town?');
  s.store.run('INSERT INTO memory_dependencies VALUES(?,?)', record.id, context);
  pending(s, 'My bike is jade.');
  const snapshot = await backup(s.store), external = mkdtempSync(join(tmpdir(), 'pikobot-memory-v7-')); directories.push(external); cpSync(snapshot.path, external, { recursive: true });
  const old = new DatabaseSync(join(external, 'pikobot.sqlite'));
  old.exec("UPDATE memories SET status='candidate' WHERE status='stored'; ALTER TABLE run_sources DROP COLUMN inherited; PRAGMA user_version=7"); old.close();
  const manifest = { ...snapshot.manifest, files: snapshot.manifest.files.map(file => file.path === 'pikobot.sqlite' ? { ...file, hash: hash(readFileSync(join(external, file.path))) } : file) };
  writeFileSync(join(external, 'manifest.json'), json(manifest));
  s.store.db.exec("UPDATE memories SET status='candidate' WHERE status='stored'; ALTER TABLE run_sources DROP COLUMN inherited; PRAGMA user_version=7");
  const upgraded = new Store(s.root, s.config);
  try {
    const memory = new Memory(upgraded);
    expect(memory.list()).toHaveLength(2);
    expect(memory.read(record.id).memory).toEqual({ ...record, status: 'stored', version: 1 });
    expect(memory.read(record.id).context).toContainEqual(expect.objectContaining({ id: context }));
    expect(memory.read(legacy.id).originalEvidence).toMatchObject({ id: record.source_id });
    expect(upgraded.get<any>('SELECT status FROM reviews').status).toBe('pending');
    expect(upgraded.get<any>('PRAGMA user_version').user_version).toBe(15);
  } finally { upgraded.close(); }
  await s.runtime.close(); s.store.close(); instances.splice(instances.indexOf(s), 1); directories.push(s.root);
  await restore(s.root, external, true);
  const restored = new Store(s.root, s.config);
  try {
    const memory = new Memory(restored);
    expect(memory.read(record.id).memory).toEqual({ ...record, status: 'stored', version: 1 });
    expect(memory.read(legacy.id).originalEvidence).toMatchObject({ id: record.source_id });
    memory.forget(legacy.id);
    expect(memory.source(record.source_id)).toBeUndefined(); expect(memory.list()).toEqual([]);
    expect(restored.all('SELECT * FROM memory_confirmations')).toEqual([]);
  } finally { restored.close(); }
  await restore(s.root, external, true);
  const erased = new Store(s.root, s.config);
  try { expect(erased.all('SELECT * FROM memories')).toEqual([]); expect(erased.all('PRAGMA foreign_key_check')).toEqual([]); } finally { erased.close(); }
});

it('upgrades schema six without losing statements, owner assertions, lineage or extraction queues', () => {
  const s = instance(), record = s.runtime.remember('town', 'Ancona') as any; pending(s, 'My bike is jade.');
  s.store.db.exec('DROP TRIGGER mem0_erase_entities; DROP TABLE mem0_vectors; CREATE TABLE vectors(id TEXT PRIMARY KEY REFERENCES retrieval(id) ON DELETE CASCADE,model TEXT,dimensions INTEGER,version TEXT,vector TEXT); ALTER TABLE run_sources DROP COLUMN inherited; PRAGMA user_version=6');
  const reopened = new Store(s.root, s.config); try {
    expect(reopened.get<any>('PRAGMA user_version').user_version).toBe(15);
    expect(reopened.get<any>('SELECT * FROM memories WHERE id=?', record.id).value).toBe('Ancona');
    expect(reopened.get<any>('SELECT status FROM reviews').status).toBe('pending');
    expect(reopened.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(reopened.get("SELECT name FROM sqlite_master WHERE name='vectors'")).toBeUndefined();
    expect(reopened.all('SELECT * FROM mem0_vectors')).toEqual([]);
  } finally { reopened.close(); }
});
