import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { hash, json } from '../src/store.js';
import type { Envelope } from '../src/contracts.js';
import { setup, source } from './helpers.js';

const instances: ReturnType<typeof setup>[] = [];
const instance = () => { const s = setup(); instances.push(s); return s; };
afterEach(async () => { for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } });
function context(s: ReturnType<typeof setup>, changes: Partial<Envelope> = {}): Envelope {
  const conversation = s.runtime.newConversation('Receipt inspection', changes.mode === 'ephemeral');
  const result = { ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: conversation.id, runId: crypto.randomUUID(), source, mode: 'foreground' as const, ...changes };
  return result;
}
async function list(s: ReturnType<typeof setup>, args: Record<string, unknown> = {}, envelope = context(s)): Promise<any> {
  if (envelope.mode !== 'ephemeral' && !s.store.get('SELECT id FROM runs WHERE id=?', envelope.runId)) s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', envelope.runId, envelope.conversationId, envelope.runId, json(envelope), 'completed', Date.now(), Date.now());
  const tool = s.runtime.availableTools(envelope).find(tool => tool.name === 'receipts_list');
  expect(tool, 'Receipt discovery is available without knowing an operation ID').toBeDefined();
  const result = await tool!.execute(crypto.randomUUID(), args);
  return JSON.parse((result.content[0] as { text: string }).text);
}

it('discovers the matching operator invocation across conversations without exposing results or repeating it', async () => {
  const s = instance(), target = { action: 'create', title: 'Target list', items: ['Private contents must not appear in metadata'] };
  const owner = context(s);
  await s.runtime.invokeExtension('lists', target, owner);
  await s.runtime.invokeExtension('lists', { ...target, title: 'Later unrelated list' }, context(s));
  const found = await list(s, { tool: 'lists', input: target });
  expect(found.receipts).toHaveLength(1);
  expect(found.receipts[0]).toMatchObject({ tool: 'lists', operationStatus: 'completed', runStatus: 'completed', resultAvailable: true, sourceId: `operation:${owner.runId}:owner-invoke` });
  expect(found.inputMatched).toBe(true); expect(found.nextBefore).toBeNull();
  expect(JSON.stringify(found)).not.toContain('Private contents');
  expect(s.store.all('SELECT * FROM documents')).toHaveLength(2);
  expect(s.runtime.memory.source(found.receipts[0].sourceId)?.text).toContain('Private contents');
  expect(await list(s, { tool: 'lists', input: { ...target, title: 'No matching invocation' } })).toMatchObject({ receipts: [], inputMatched: false });
});

it('paginates stably while excluding service journals, discovery reads, the active run and erased results', async () => {
  const s = instance(), owner = context(s);
  await s.runtime.invokeExtension('agenda', {}, owner); s.store.run('DELETE FROM operations WHERE run_id=?', owner.runId);
  for (let n = 0; n < 5; n++) s.store.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', `receipt-${n}`, owner.runId, 'fixture_effect', hash('{}'), 'completed', json({ content: [] }), Date.now());
  for (const [id, tool, result] of [['private', '$model.complete', '{}'], ['erased', 'fixture_effect', null], ['discovery', 'receipts_list', '{}'], ['reader', 'source_read', '{}']] as const) s.store.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', id, owner.runId, tool, hash('{}'), 'completed', result, Date.now());
  const first = await list(s, { limit: 2 });
  expect(first.receipts.map((row: any) => row.id)).toEqual(['receipt-4', 'receipt-3']);
  const next = await list(s, { limit: 2, before: first.nextBefore });
  expect(next.receipts.map((row: any) => row.id)).toEqual(['receipt-2', 'receipt-1']);
  const last = await list(s, { limit: 2, before: next.nextBefore });
  expect(last.receipts.map((row: any) => row.id)).toEqual(['receipt-0']); expect(last.nextBefore).toBeNull();
  expect((await list(s, {}, owner)).receipts).toEqual([]);
});

it('keeps unknown/failed execution distinct from accepted effects and exposes no invented original for missing results', async () => {
  const s = instance(), owner = context(s);
  await s.runtime.invokeExtension('agenda', {}, owner); s.store.run('DELETE FROM operations WHERE run_id=?', owner.runId);
  for (const status of ['running', 'uncertain', 'failed']) s.store.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', `receipt-${status}`, owner.runId, 'fixture_effect', hash('{}'), status, status === 'failed' ? json({ content: [{ type: 'text', text: 'Provider rejected' }], isError: true }) : null, Date.now());
  const found = await list(s, { tool: 'fixture_effect' });
  expect(found.receipts).toHaveLength(3);
  for (const row of found.receipts) {
    expect(row.resultAvailable).toBe(row.operationStatus === 'failed');
    expect(row.sourceId).toBe(row.operationStatus === 'failed' ? 'operation:receipt-failed' : undefined);
  }
  expect(found.evidence).toMatch(/not.*acceptance|not.*effect/i);
});

it.each(['untrusted', 'scheduled', 'review', 'foreign-owner', 'foreign-instance'])('denies %s discovery without exposing owner receipt metadata', async denied => {
  const s = instance(), changes: Partial<Envelope> = denied === 'untrusted' ? { source: { ...source, trustedOwner: false } } : denied === 'foreign-owner' ? { ownerId: 'foreign' } : denied === 'foreign-instance' ? { instanceId: 'foreign' } : { mode: denied as Envelope['mode'] };
  await expect(list(s, {}, context(s, changes))).rejects.toThrow();
});

it('validates unknown fields and bounds before querying historical receipts', async () => {
  const s = instance();
  for (const args of [{ ownerId: s.config.ownerId }, { limit: 0 }, { limit: 21 }, { before: 0 }, { before: 1.5 }, { input: {} }, { input: [] }, { tool: '' }, { tool: 'x'.repeat(121) }]) await expect(list(s, args)).rejects.toThrow();
});

it('preserves upstream erasure lineage and excludes a scrubbed old receipt while keeping unrelated receipts', async () => {
  const s = instance(), fact = s.runtime.remember('synthetic receipt dependency', 'private context') as { id: string; source_id: string }, owner = context(s);
  await s.runtime.invokeExtension('agenda', {}, owner); s.store.linkSource(owner.runId, fact.source_id);
  const reader = context(s), found = await list(s, { tool: 'agenda' }, reader);
  expect(found.receipts[0].sourceId).toBe(`operation:${owner.runId}:owner-invoke`);
  expect(s.store.all('SELECT source_id,inherited FROM run_sources WHERE run_id=?', reader.runId)).toContainEqual({ source_id: fact.source_id, inherited: 1 });
  await s.runtime.invokeExtension('agenda', { timezone: 'UTC' }, context(s));
  await s.runtime.forget(fact.id);
  expect((await list(s, { tool: 'agenda' })).receipts).toHaveLength(1);
  expect(s.runtime.memory.source(found.receipts[0].sourceId)).toBeUndefined();
});

it('allows trusted ephemeral inspection without creating durable journals or source dependencies', async () => {
  const s = instance(); await s.runtime.invokeExtension('agenda', {}, context(s));
  const before = { operations: s.store.all('SELECT * FROM operations'), sources: s.store.all('SELECT * FROM run_sources') };
  expect((await list(s, { tool: 'agenda' }, context(s, { mode: 'ephemeral' }))).receipts).toHaveLength(1);
  expect(s.store.all('SELECT * FROM operations')).toEqual(before.operations); expect(s.store.all('SELECT * FROM run_sources')).toEqual(before.sources);
});
