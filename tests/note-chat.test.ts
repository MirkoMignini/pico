import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setup, source, waitFor, loadTools } from './helpers.js';
import { Runtime } from '../src/runtime.js';
import type { Envelope } from '../src/contracts.js';

const instances: ReturnType<typeof setup>[] = [];
const instance = () => { const s = setup(); instances.push(s); return s; };
afterEach(async () => { vi.restoreAllMocks(); for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); } });
async function turn(s: ReturnType<typeof setup>, conversationId: string, text: string, calls: { name: string; args: Record<string, unknown> }[], sender: Envelope['source'] = source, mode: Envelope['mode'] = 'foreground') {
  s.faux.appendResponses([loadTools(...new Set(calls.map(call => call.name))),fauxAssistantMessage(calls.map(call => fauxToolCall(call.name, call.args)), { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Done.')])]);
  const run = await s.runtime.ingest({ conversationId, requestId: crypto.randomUUID(), text }, sender, mode);
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  if (s.runtime.isEphemeral(conversationId)) return (s.runtime.history(conversationId) as { role: string; toolName?: string }[]).filter(message => message.role === 'toolResult' && message.toolName !== 'tools_load') as any[];
  return s.store.all<{ body: string }>("SELECT body FROM messages WHERE run_id=? AND role='toolResult' AND json_extract(body,'$.toolName')!='tools_load' ORDER BY rowid", run.id).map(row => JSON.parse(row.body));
}

it('consolidates bare checklist additions in lists without blank placeholders or duplicate IDs', async () => {
  const s = instance(), c = s.runtime.newConversation();
  const created = await turn(s, c.id, 'Crea una lista di cose da prendere in cantina', [{ name: 'lists', args: { action: 'create', title: 'Cantina', items: [] } }]);
  expect(created[0].isError).not.toBe(true);
  const doc = JSON.parse(created[0].content[0].text); expect(s.runtime.knowledge.items(doc.id)).toEqual([]);
  const results = await turn(s, c.id, 'Detersivo nero\nDetersivo ace bianco', [{ name: 'lists', args: { action: 'add', id: doc.id, items: ['Detersivo nero', 'Detersivo Ace bianco'] } }]);
  expect(results[0].isError).not.toBe(true);
  const firstId = s.runtime.knowledge.items(doc.id)[0]!.id;
  await turn(s, c.id, 'Sacchi', [{ name: 'lists', args: { action: 'add', id: doc.id, items: ['Sacchi'] } }]);
  expect(s.runtime.knowledge.items(doc.id).map(item => item.text)).toEqual(['Detersivo nero', 'Detersivo Ace bianco', 'Sacchi']);
  expect(s.runtime.knowledge.items(doc.id)[0]!.id).toBe(firstId);
  expect(() => s.runtime.knowledge.checklist(doc.id, 3, firstId, '   ')).toThrow('cannot be empty');
});

it('continues an authored note after reconstruction without losing text or lineage', async () => {
  const s = instance(), c = s.runtime.newConversation();
  await turn(s, c.id, 'Create a note for the trip', [{ name: 'notes', args: { action: 'create', title: 'Trip', markdown: 'Plans.' } }]);
  const doc = s.runtime.knowledge.list().documents[0] as { id: string };
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models);
  const results = await turn(s, c.id, 'Bring the blue bag.', [{ name: 'notes', args: { action: 'edit', id: doc.id, expectedRevision: 1, find: 'Plans.', replace: 'Plans.\n\nBring the blue bag.' } }]);
  expect(results[0].isError).not.toBe(true); expect(s.runtime.knowledge.revision(doc.id).note_text).toBe('Plans.\n\nBring the blue bag.');
  const userIds = s.store.all<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid", c.id).map(row => row.id);
  expect(JSON.parse(s.runtime.knowledge.revision(doc.id).conversion!).dependencies).toEqual(expect.arrayContaining(userIds));
});

it('lets the LLM create and edit notes across conversations without confirmation, command words or drafting sessions', async () => {
  const s = instance(), c = s.runtime.newConversation(), other = s.runtime.knowledge.createNote('Other', 'Original.', 'other');
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple');
  const created = await turn(s, c.id, 'Passport for the trip', [{ name: 'notes', args: { action: 'create', title: 'Packing', markdown: 'Intro.\n- [ ] Passport' } }]);
  expect(created[0].isError).not.toBe(true);
  const prompt = stream.mock.calls[1]![1].messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  expect(prompt).toContain('Manage notes/lists from owner needs and natural follow-ups without mandatory confirmation, explicit save wording, command words or drafting sessions');
  expect(prompt).not.toContain('Persist non-list notes only on explicit owner');
  const doc = JSON.parse(created[0].content[0].text), item = s.runtime.knowledge.items(doc.id)[0]!;
  const results = await turn(s, s.runtime.newConversation().id, 'Jacket', [
    { name: 'notes', args: { action: 'edit', id: other.id, expectedRevision: 1, find: 'Original.', replace: 'Original.\nJacket' } },
    { name: 'notes', args: { action: 'create', title: 'Jacket', markdown: 'A jacket is useful for this trip.' } },
    { name: 'notes', args: { action: 'edit', id: doc.id, expectedRevision: 1, find: 'Intro.', replace: 'Packing for the trip.' } },
    { name: 'lists', args: { action: 'add', id: doc.id, items: ['Jacket'] } }
  ]);
  expect(results.every(result => !result.isError)).toBe(true);
  expect(s.runtime.knowledge.items(doc.id)[0]).toEqual(item);
  expect(s.runtime.knowledge.items(doc.id).map(item => item.text)).toEqual(['Passport', 'Jacket']);
  expect(s.runtime.knowledge.revision(doc.id).note_text).toContain('Packing for the trip.');
  expect(s.runtime.knowledge.revision(other.id).note_text).toBe('Original.\nJacket');
});

it('keeps note schemas, exact spans and revision conflicts strict under delegated writes', async () => {
  const s = instance(), c = s.runtime.newConversation(), doc = s.runtime.knowledge.createNote('Note', 'Original. Original.', 'original');
  const results = await turn(s, c.id, 'Jacket', [
    { name: 'notes', args: { action: 'edit', id: doc.id, expectedRevision: 99, find: 'Original. Original.', replace: 'Jacket' } },
    { name: 'notes', args: { action: 'edit', id: doc.id, expectedRevision: 1, find: 'Original.', replace: 'Jacket' } },
    { name: 'notes', args: { action: 'create', title: 'Bad', markdown: 'Jacket', ownerId: 'foreign' } },
    { name: 'lists', args: { action: 'add', id: doc.id, items: ['Jacket'], submission: 'invalid' } }
  ]);
  expect(results.every(result => result.isError)).toBe(true);
  expect(s.runtime.knowledge.revision(doc.id).note_text).toBe('Original. Original.');
  expect(s.runtime.knowledge.document(doc.id).current_revision).toBe(1); expect(s.runtime.knowledge.list().total).toBe(1);
});

it('assigns creation identities and refuses deleted note targets without imposing a drafting context', async () => {
  const s = instance(), c = s.runtime.newConversation(), ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const results = await turn(s, c.id, 'Something useful for later', [{ name: 'notes', args: { action: 'create', title: 'Note', markdown: 'Original.' } }]);
    expect(results[0].isError).not.toBe(true); ids.push(JSON.parse(results[0].content[0].text).id);
  }
  expect(new Set(ids).size).toBe(2); await s.runtime.knowledge.operate({ action: 'delete', id: ids[1] });
  const results = await turn(s, c.id, 'Jacket', [
    { name: 'notes', args: { action: 'edit', id: ids[1], expectedRevision: 1, find: 'Original.', replace: 'Original.\nJacket' } },
    { name: 'notes', args: { action: 'edit', id: ids[0], expectedRevision: 1, find: 'Original.', replace: 'Original.\nJacket' } }
  ]);
  expect(results[0].isError).toBe(true); expect(results[1].isError).not.toBe(true);
  expect(s.runtime.knowledge.revision(ids[0]!).note_text).toBe('Original.\nJacket');
});

it('keeps failed additions distinct from saved contents despite inferred memory claims', async () => {
  const s = instance(), c = s.runtime.newConversation(), k = s.runtime.knowledge;
  const created = await turn(s, c.id, 'A cellar list', [{ name: 'lists', args: { action: 'create', title: 'Cellar list', items: [] } }]), doc = JSON.parse(created[0].content[0].text);
  const failed = await turn(s, c.id, 'Black detergent\nWhite detergent', [{ name: 'lists', args: { action: 'update', id: doc.id, expectedRevision: 99, itemId: crypto.randomUUID(), text: 'Black detergent' } }]);
  expect(failed[0].isError).toBe(true);
  const failedSource = s.store.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1", c.id)!.id;
  s.runtime.memory.remember({ entity: `owner:${s.config.ownerId}`, kind: 'commitment', key: 'cellar list', value: 'Cellar list already contains black detergent and white detergent.', quote: 'Black detergent\nWhite detergent', sourceId: failedSource, eventAt: Date.now() }, false);
  const stream = vi.spyOn(s.runtime.models.models, 'streamSimple'); s.faux.appendResponses([
    fauxAssistantMessage([fauxToolCall('memory_search', { query: 'cellar list' })], { stopReason: 'toolUse' }),
    loadTools('lists'), fauxAssistantMessage([fauxToolCall('lists', { action: 'read', id: doc.id })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('The saved list is empty; additions were not saved.')])
  ]);
  const recall = await s.runtime.ingest({ conversationId: s.runtime.newConversation().id, requestId: 'cellar-recall', text: `What is on my Cellar list ${doc.id}?` }, source);
  await waitFor(() => s.runtime.run(recall.id).status === 'completed');
  const request = stream.mock.calls.at(-1)![1], system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const result = request.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'lists') as any;
  expect(JSON.parse(result.content[0].text), k.diagnostic).toMatchObject({ allItems: 0, incomplete: 0, complete: 0 });
  expect(system).toContain('Saved note/list contents come from canonical knowledge, not personal memory, remembered requests or assistant replies');
  expect(system).toContain('a failed addition was never saved'); expect(JSON.stringify(request)).toContain('Cellar list already contains black detergent and white detergent.');
  const added = await turn(s, c.id, 'Gentle bleach', [{ name: 'lists', args: { action: 'add', id: doc.id, items: ['Gentle bleach'] } }]);
  expect(JSON.parse(added[0].content[0].text)).toMatchObject({ allItems: 1, incomplete: 1, complete: 0, effect: 'added' });
  expect(k.items(doc.id).map(item => item.text)).toEqual(['Gentle bleach']); expect(k.items(doc.id, 1)).toEqual([]); expect(s.runtime.memory.list()).toHaveLength(1);
});

it('ignores legacy blank placeholders while preserving real item IDs and completion', async () => {
  const s = instance(), k = s.runtime.knowledge, doc = k.createNote('Legacy list', '', 'legacy-list'), empty = crypto.randomUUID(), real = crypto.randomUUID();
  s.store.run('UPDATE document_revisions SET note_text=? WHERE document_id=?', `- [ ]  <!-- item:${empty} -->\n- [x] Passport <!-- item:${real} -->\n`, doc.id);
  expect(k.items(doc.id)).toEqual([{ id: real, text: 'Passport', completed: true, line: 2 }]); expect(await k.operate({ action: 'items', id: doc.id })).toMatchObject({ allItems: 1, incomplete: 0, complete: 1 });
});

it('counts complete saved revisions even when the source window is incomplete', async () => {
  const s = instance(), k = s.runtime.knowledge, created = await k.operate({ action: 'create', title: 'Large list', markdown: Array.from({ length: 130 }, (_, i) => `- [ ] Item ${i}`).join('\n'), submission: 'large-list' });
  expect(created.evidence.checklist).toEqual({ allItems: 130, incomplete: 130, complete: 0 });
  const item = k.items(created.id)[0]!, marked = await k.operate({ action: 'checklist', id: created.id, expectedRevision: 1, itemId: item.id, completed: true });
  expect(marked.evidence.checklist).toEqual({ allItems: 130, incomplete: 129, complete: 1 });
  const edited = await k.operate({ action: 'edit', id: created.id, expectedRevision: 2, find: 'Item 1 ', replace: 'Updated item 1 ' });
  expect(edited.evidence.checklist).toEqual({ allItems: 130, incomplete: 129, complete: 1 }); expect(k.read(created.id, 1).checklist).toEqual({ allItems: 130, incomplete: 130, complete: 0 }); expect(k.read(created.id, 3, 1, 1).checklist).toEqual({ allItems: 130, incomplete: 129, complete: 1 });
});

it.each(['untrusted', 'ephemeral', 'scheduled', 'review'] as const)('denies note and document mutations in %s work without widening delegated authority', async mode => {
  const s = instance(), doc = s.runtime.knowledge.createNote('Note', 'Original.', 'original');
  const attachmentId = s.runtime.media.save(Buffer.from('Retained original'), 'original.txt', 'text/plain');
  const original = await s.runtime.knowledge.importAttachment(attachmentId, 'original-file');
  const c = s.runtime.newConversation('Restricted', mode === 'ephemeral');
  const results = await turn(s, c.id, 'Anything useful for later', [
    { name: 'notes', args: { action: 'create', title: 'New', markdown: 'New content' } },
    { name: 'notes', args: { action: 'edit', id: doc.id, expectedRevision: 1, find: 'Original.', replace: 'Changed.' } },
    { name: 'documents', args: { action: 'import', attachmentId } },
    { name: 'documents', args: { action: 'replace', id: original.id, expectedRevision: 1, attachmentId } },
    { name: 'documents', args: { action: 'delete', id: doc.id } },
    { name: 'documents', args: { action: 'forget', id: original.id } }
  ], { ...source, trustedOwner: mode !== 'untrusted' }, mode === 'scheduled' || mode === 'review' ? mode : 'foreground');
  expect(results).toHaveLength(6); expect(results.every(result => result.isError)).toBe(true);
  expect(s.runtime.knowledge.list().total).toBe(2); expect(s.runtime.knowledge.revision(doc.id).note_text).toBe('Original.');
  expect(s.runtime.knowledge.document(original.id).current_revision).toBe(1);
});

it('denies checklist persistence in untrusted, ephemeral and scheduled execution', async () => {
  const s = instance(), c = s.runtime.newConversation(), doc = s.runtime.knowledge.createNote('List', '', 'list');
  const call = { name: 'lists', args: { action: 'add', id: doc.id, items: ['Jacket'] } };
  for (const [conversation, sender, mode] of [[c, { ...source, trustedOwner: false }, 'foreground'], [s.runtime.newConversation('Private', true), source, 'foreground'], [c, source, 'scheduled']] as const) {
    const results = await turn(s, conversation.id, 'Jacket', [call], sender, mode); expect(results[0].isError).toBe(true); expect(s.runtime.knowledge.items(doc.id)).toEqual([]);
  }
});
