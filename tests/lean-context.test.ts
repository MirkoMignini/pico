import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { setup, source, waitFor, loadTools } from './helpers.js';

const instances: ReturnType<typeof setup>[] = [];
const instance = () => { const s = setup(); instances.push(s); return s; };
afterEach(async () => { vi.restoreAllMocks(); for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } });
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const answer = (text = 'Synthetic reply.') => fauxAssistantMessage([fauxText(text)]);
async function settled(s: ReturnType<typeof setup>, conversationId: string, text: string) {
  const run = await s.runtime.ingest({ requestId: crypto.randomUUID(), conversationId, text }, source);
  await waitFor(() => !s.runtime.hasPendingRuns);
  expect(s.runtime.run(run.id).status, s.runtime.run(run.id).error).toBe('completed'); return run;
}

it('starts with eight tools and owner basics, without searching or injecting unrelated history/documents', async () => {
  const s = instance(), session = s.runtime.newConversation(), sourceId = s.runtime.ownerEvidence('My fictional locker code is LOCKER-684.');
  s.runtime.memory.remember({ entity: `owner:${s.config.ownerId}`, key: 'locker_code', value: 'LOCKER-684', kind: 'fact', quote: 'LOCKER-684', sourceId, eventAt: 1 }, false);
  s.runtime.remember('name', 'Rowan'); s.runtime.knowledge.createNote('Unrelated archive', 'ARCHIVE_NOT_FOR_GREETING', 'unrelated');
  const memory = vi.spyOn(s.runtime.memory, 'search'), documents = vi.spyOn(s.runtime.knowledge, 'search');
  s.faux.appendResponses([request => {
    const tools = getCurrentTools(request.messages), system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(tools.map(t => t.name)).toEqual(['tools_load', 'time', 'memory_search', 'memory_read', 'source_read', 'receipts_list', 'schedules_list', 'schedule_manage']);
    expect(system).toContain('Rowan'); expect(system).not.toContain('LOCKER-684'); expect(system).not.toContain('ARCHIVE_NOT_FOR_GREETING');
    expect(system).toContain('memory_search'); expect(system).not.toContain('"purpose":');
    expect(request.messages[0]!.content.length + JSON.stringify(tools).length).toBeLessThan(14_000);
    return answer('Hi Rowan.');
  }]);
  const run = await settled(s, session.id, 'Hello');
  expect(memory).not.toHaveBeenCalled(); expect(documents).not.toHaveBeenCalled();
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', run.id)).not.toContainEqual({ source_id: sourceId });
});

it('erases answers and receipts that only discovered document titles, without reading their contents', async () => {
  const s = instance(), sourceId = s.runtime.ownerEvidence('Here is my fictional station itinerary.');
  const doc = s.runtime.knowledge.createNote('PRIVATE_TITLE_ONLY', 'DOCUMENT_BODY_ONLY', 'metadata-erasure', { author: `human:${s.config.ownerId}`, sourceId, channel: 'terminal' });
  const read = vi.spyOn(s.runtime.knowledge, 'read');
  s.faux.appendResponses([call('source_read', { id: sourceId }), request => {
    expect(JSON.stringify(request)).toContain('PRIVATE_TITLE_ONLY'); expect(JSON.stringify(request)).not.toContain('DOCUMENT_BODY_ONLY'); return answer('Itinerary found.');
  }]);
  const run = await settled(s, s.runtime.newConversation().id, 'Find my itinerary');
  expect(read).not.toHaveBeenCalled();
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', run.id)).toContainEqual({ source_id: `document:${doc.id}:r1` });
  await s.runtime.deleteKnowledge(doc.id, true);
  expect(s.store.all("SELECT id FROM messages WHERE run_id=? AND role!='user'", run.id)).toEqual([]);
  expect(s.store.all('SELECT result FROM operations WHERE run_id=?', run.id).every(row => row.result === null)).toBe(true);
});

it('keeps approved procedures discoverable without injecting their bodies or unapproved/wrong-scope skills', async () => {
  const s = instance(), skill = s.runtime.skills.learn('Parcel handling', 'SKILL_BODY_ONLY: check the parcel reference, then report it.') as { id: string; version: number };
  const candidate = s.runtime.skills.learn('CANDIDATE_ONLY', 'Unapproved procedure.') as { id: string };
  s.store.run("UPDATE skills SET status='candidate' WHERE id=?", candidate.id);
  s.runtime.skills.learn('WRONG_SCOPE_ONLY', 'Telegram-only procedure.', 'telegram');
  s.faux.appendResponses([request => {
    const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(system).toContain('Parcel handling'); expect(system).toContain(skill.id);
    for (const text of ['SKILL_BODY_ONLY', 'CANDIDATE_ONLY', 'WRONG_SCOPE_ONLY']) expect(system).not.toContain(text);
    return loadTools('skills_read');
  }, () => call('skills_read', { id: skill.id, version: skill.version }), request => {
    expect(JSON.stringify(request.messages.findLast(m => m.role === 'toolResult'))).toContain('SKILL_BODY_ONLY'); return answer();
  }]);
  await settled(s, s.runtime.newConversation().id, 'Please organize a parcel');
  await s.runtime.extensions.disable('skills');
  s.faux.appendResponses([request => { expect(JSON.stringify(request)).not.toContain(skill.id); return answer(); }]);
  await settled(s, s.runtime.newConversation().id, 'Hello');
});

it.each([false, true])('recalls a sourced non-basic fact only through explicit tools (ephemeral=%s)', async ephemeral => {
  const s = instance(), sourceId = s.runtime.ownerEvidence('My fictional locker code is LOCKER-684.');
  const fact = s.runtime.memory.remember({ entity: `owner:${s.config.ownerId}`, key: 'locker_code', value: 'LOCKER-684', kind: 'fact', quote: 'LOCKER-684', sourceId, eventAt: 1 }, false);
  const session = s.runtime.newConversation('Recall', ephemeral), search = vi.spyOn(s.runtime.memory, 'search'), before = s.store.all('SELECT * FROM operations');
  s.faux.appendResponses([request => {
    expect(JSON.stringify(request)).not.toContain('LOCKER-684'); return call('memory_search', { query: 'locker code' });
  }, request => {
    expect(JSON.stringify(request)).toContain('LOCKER-684'); return call('memory_read', { id: fact.id });
  }, request => {
    const result = request.messages.findLast(m => m.role === 'toolResult');
    expect(JSON.stringify(result)).toContain(sourceId); expect(JSON.stringify(result)).toContain(`human:${s.config.ownerId}`); return answer('LOCKER-684');
  }]);
  const run = await settled(s, session.id, 'What is my locker code?');
  expect(search).toHaveBeenCalledOnce(); expect(search.mock.calls[0]![1]?.limit).toBeUndefined();
  if (ephemeral) expect(s.store.all('SELECT * FROM operations')).toEqual(before);
  else expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', run.id)).toContainEqual({ source_id: sourceId });
});

it.each([false, true])('finds a source-linked document on demand without automatically reading it (ephemeral=%s)', async ephemeral => {
  const s = instance(), sourceId = s.runtime.ownerEvidence('Here is my fictional station itinerary.');
  const doc = s.runtime.knowledge.createNote('Station itinerary', 'Synthetic platform reference PLATFORM-926.', 'station-reference', { author: `human:${s.config.ownerId}`, sourceId, channel: 'terminal' });
  const session = s.runtime.newConversation('Separate recall', ephemeral);
  const search = vi.spyOn(s.runtime.memory, 'search'), documents = vi.spyOn(s.runtime.knowledge, 'search');
  s.faux.appendResponses([request => {
    expect(JSON.stringify(request)).not.toContain('PLATFORM-926'); return call('memory_search', { query: 'station itinerary' });
  }, () => call('source_read', { id: sourceId }), request => {
    const result = request.messages.findLast(m => m.role === 'toolResult');
    if (result?.role !== 'toolResult') throw new Error('Missing source');
    expect(JSON.parse((result.content[0] as { text: string }).text).documents).toContainEqual(expect.objectContaining({ documentId: doc.id, revision: 1 }));
    expect(JSON.stringify(result)).not.toContain('PLATFORM-926'); return loadTools('documents');
  }, () => call('documents', { action: 'read', id: doc.id }), request => {
    expect(JSON.stringify(request.messages.findLast(m => m.role === 'toolResult'))).toContain('PLATFORM-926'); return answer('PLATFORM-926');
  }]);
  const run = await settled(s, session.id, 'What is the platform reference on the itinerary I supplied?');
  expect(search).toHaveBeenCalledOnce(); expect(documents).not.toHaveBeenCalled();
  if (!ephemeral) expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', run.id)).toContainEqual({ source_id: `document:${doc.id}:r1` });
});
