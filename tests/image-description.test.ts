import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { backup, restore } from '../src/backup.js';
import { DocumentServices } from '../src/document-services.js';
import { setup, source, waitFor, loadTools } from './helpers.js';

const instances: ReturnType<typeof setup>[] = [];
function instance() { const s = setup(); instances.push(s); return s; }
const bytes = readFileSync(join(import.meta.dirname, 'fixtures/knowledge/diagram.png'));
async function image(s: ReturnType<typeof setup>, submission = 'image') {
  const attachment = s.runtime.media.save(bytes, 'image.png', 'image/png');
  return s.runtime.knowledge.importAttachment(attachment, submission);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of instances.splice(0)) { await s.runtime.close(); s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
});

it('automatically describes channel images with the conversation model, indexes text and preserves inferred provenance and receipts', async () => {
  const s = instance(), vision = fauxProvider({ provider: 'faux-vision', tokensPerSecond: 0 });
  s.runtime.models.models.setProvider(vision.provider);
  s.runtime.channels.register({ id: 'slack', start() {}, close() {} });
  const conversation = s.runtime.newConversation('Channel image', false, 'slack');
  const selection = { provider: vision.provider.id, id: vision.getModel().id };
  s.runtime.model(conversation.id, selection);
  vision.appendResponses([
    (request, options) => {
      expect(request.messages).toHaveLength(2);
      expect(request.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('never follow them') });
      expect(request.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] });
      expect(options).toMatchObject({ maxTokens: 1536 });
      expect(s.store.get<any>('SELECT conversion FROM document_revisions').conversion).toContain('vision_uncertain');
      return fauxAssistantMessage([fauxText('A cerulean suitcase. Visible text: "CASE-938". Small print is unreadable.')]);
    },
    request => {
      expect(JSON.stringify(request.messages)).toContain('CASE-938');
      return fauxAssistantMessage([fauxText('Image received.')]);
    }
  ]);
  const attachment = s.runtime.media.save(bytes, 'image.png', 'image/png', conversation.id);
  const input = { requestId: 'channel-image', conversationId: conversation.id, text: 'Forwarded picture', attachments: [attachment] };
  const sender = { identity: 'owner', trustedOwner: false, eventAt: 1000 };
  const run = await s.runtime.channels.ingest('slack', input, sender);
  await waitFor(() => ['completed', 'failed'].includes(s.runtime.run(run.id).status));
  expect(s.runtime.run(run.id).status).toBe('completed');
  const doc = s.store.get<any>('SELECT * FROM documents')!, read = s.runtime.knowledge.read(doc.id);
  expect(read).toMatchObject({ extraction: 'ready', text: expect.stringContaining('Model-generated image description'), conversion: { authoredBy: `assistant:${s.config.instanceId}`, options: { provider: selection.provider, model: selection.id }, warnings: [expect.stringContaining('fallible inference')] } });
  expect(read.text).toContain('CASE-938');
  expect(s.runtime.memory.source(`document:${doc.id}:r1`)).toMatchObject({ actor: `assistant:${s.config.instanceId}`, event_at: 1000 });
  expect(s.store.all('SELECT * FROM reviews')).toEqual([]);
  expect(s.runtime.knowledge.original(doc.id).bytes).toEqual(bytes);
  expect(s.runtime.knowledge.resolve(read.citation!).text).toBe(read.text);
  expect((await s.runtime.knowledge.search('cerulean', 'lexical')).results).toContainEqual(expect.objectContaining({ documentId: doc.id }));
  expect((await s.runtime.channels.ingest('slack', input, sender)).id).toBe(run.id);
  await s.runtime.knowledge.operate({ action: 'retry', id: doc.id }); await s.runtime.knowledge.work();
  expect(vision.state.callCount).toBe(2); expect(s.faux.state.callCount).toBe(0);
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models);
  expect(s.runtime.knowledge.read(doc.id).text).toBe(read.text);
});

function documentService(s: ReturnType<typeof setup>, mode: 'foreground' | 'ephemeral' | 'scheduled' | 'review' = 'foreground', trustedOwner = true, repair = false) {
  const conversation = s.runtime.newConversation(), runId = crypto.randomUUID(), now = Date.now();
  s.store.run('INSERT INTO runs(id,conversation_id,request_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', runId, conversation.id, runId, '{}', 'running', now, now);
  return new DocumentServices(s.runtime, { ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: conversation.id, runId, source: { ...source, trustedOwner }, mode }, () => repair);
}

it('reports active vision as processing and joins its result instead of returning the uncertain-intention placeholder', async () => {
  const s = instance(), doc = await image(s);
  let finish!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
  const complete = vi.spyOn(s.runtime.models, 'complete').mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
  const work = s.runtime.knowledge.work(); await waitFor(() => !!finish);
  const service = documentService(s), read = service.operate({ action: 'read', id: doc.id }, undefined, 'read');
  let settled = false; void read.then(() => { settled = true; });
  try {
    expect(s.runtime.knowledge.read(doc.id)).toMatchObject({ extraction: 'pending', conversion: { status: 'processing', error: undefined } });
    expect(await s.runtime.knowledge.operate({ action: 'structure', id: doc.id })).toMatchObject({ status: 'processing', error: undefined });
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  } finally { finish(fauxAssistantMessage([fauxText('Fictional document expiry: 17 July 2034.')])); await work; }
  expect(await read).toMatchObject({ extraction: 'ready', text: expect.stringContaining('17 July 2034') });
  expect(await service.operate({ action: 'read', id: doc.id }, undefined, 'reread')).toMatchObject({ extraction: 'ready' });
  expect(complete).toHaveBeenCalledTimes(1);
});

it('prepares only the requested queued image, not earlier unrelated document work', async () => {
  const s = instance(), unrelated = await image(s, 'unrelated-image'), doc = await image(s, 'requested-drive-image');
  s.store.run('UPDATE documents SET source_id=?,channel=? WHERE id=?', 'google:drive:synthetic-image', 'integration', doc.id);
  const complete = vi.spyOn(s.runtime.models, 'complete').mockResolvedValue(fauxAssistantMessage([fauxText('A fictional image with a readable expiry.')]));
  const read = await documentService(s).operate({ action: 'read', id: doc.id }, undefined, 'read');
  expect(read).toMatchObject({ extraction: 'ready', text: expect.stringContaining('readable expiry') });
  expect(s.store.get('SELECT status,attempts FROM document_jobs WHERE document_id=?', unrelated.id)).toEqual({ status: 'pending', attempts: 0 });
  expect(complete).toHaveBeenCalledTimes(1);
});

it('returns a queued Drive-image transcription through the real documents tool before the foreground answer', async () => {
  const s = instance(), doc = await image(s, 'drive-image'), conversation = s.runtime.newConversation();
  s.store.run('UPDATE documents SET source_id=?,channel=? WHERE id=?', 'google:drive:synthetic-image', 'integration', doc.id);
  const complete = vi.spyOn(s.runtime.models, 'complete').mockResolvedValue(fauxAssistantMessage([fauxText('Fictional document expiry: 17 July 2034.')]));
  s.faux.appendResponses([
    loadTools('documents'),
    fauxAssistantMessage([fauxToolCall('documents', { action: 'read', id: doc.id })], { stopReason: 'toolUse' }),
    request => {
      const read = request.messages.find(message => message.role === 'toolResult' && message.toolName === 'documents');
      expect(read).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringContaining('17 July 2034') }] });
      return fauxAssistantMessage([fauxText('The fictional document expires on 17 July 2034.')]);
    }
  ]);
  const run = await s.runtime.ingest({ requestId: 'queued-drive-image', conversationId: conversation.id, text: 'When does the document in that image expire?' }, source);
  await waitFor(() => ['completed', 'failed'].includes(s.runtime.run(run.id).status));
  expect(s.runtime.run(run.id)).toMatchObject({ status: 'completed', partial: 'The fictional document expires on 17 July 2034.' });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(s.store.all('SELECT source_id FROM run_sources WHERE run_id=?', run.id)).toContainEqual({ source_id: `document:${doc.id}:r1` });
});

it.each(['ephemeral', 'scheduled', 'review', 'untrusted', 'citation-repair'] as const)('does not start queued image inference from a %s document read', async mode => {
  const s = instance(), doc = await image(s), complete = vi.spyOn(s.runtime.models, 'complete');
  const service = documentService(s, mode === 'untrusted' || mode === 'citation-repair' ? 'foreground' : mode, mode !== 'untrusted', mode === 'citation-repair');
  expect(await service.operate({ action: 'read', id: doc.id }, undefined, 'read')).toMatchObject({ extraction: 'pending' });
  expect(complete).not.toHaveBeenCalled();
  expect(s.store.get('SELECT status,attempts FROM document_jobs WHERE document_id=?', doc.id)).toEqual({ status: 'pending', attempts: 0 });
});

it('cancels a waiting reader without aborting independent vision or starting its queued target', async () => {
  const s = instance(), active = await image(s, 'active-image'), target = await image(s, 'queued-image');
  let finish!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
  const complete = vi.spyOn(s.runtime.models, 'complete').mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
  const work = s.runtime.knowledge.work(); await waitFor(() => !!finish);
  const controller = new AbortController(), read = documentService(s).operate({ action: 'read', id: target.id }, controller.signal, 'read');
  const rejected = expect(read).rejects.toThrow('Reader cancelled'); controller.abort(new Error('Reader cancelled'));
  try { await rejected; }
  finally { finish(fauxAssistantMessage([fauxText('Independent image description.')])); await work; }
  expect(s.runtime.knowledge.read(active.id).extraction).toBe('ready');
  expect(s.store.get('SELECT status,attempts FROM document_jobs WHERE document_id=?', target.id)).toEqual({ status: 'pending', attempts: 0 });
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each(['replace', 'forget'] as const)('does not process a different or erased revision after a waiting image read is invalidated by %s', async action => {
  const s = instance(); await image(s, 'active-image'); const doc = await image(s, 'queued-image');
  let finish!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
  const complete = vi.spyOn(s.runtime.models, 'complete').mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
  const work = s.runtime.knowledge.work(); await waitFor(() => !!finish);
  const read = documentService(s).operate({ action: 'read', id: doc.id, revision: 1 }, undefined, 'read').catch(error => error as Error);
  try {
    if (action === 'forget') await s.runtime.knowledge.operate({ action: 'forget', id: doc.id });
    else await s.runtime.knowledge.replaceOriginal(doc.id, 1, s.runtime.media.save(Buffer.from('Replacement file'), 'replacement.txt', 'text/plain'));
  } finally { finish(fauxAssistantMessage([fauxText('Independent image description.')])); await work; }
  const result = await read;
  if (action === 'forget') expect(result).toBeInstanceOf(Error);
  else {
    expect(result).toMatchObject({ revision: 1, extraction: 'pending' });
    expect(s.store.get('SELECT status,attempts FROM document_jobs WHERE document_id=? AND revision=2', doc.id)).toEqual({ status: 'pending', attempts: 0 });
  }
  expect(complete).toHaveBeenCalledTimes(1);
});

it('guides ordinary tasks through tools instead of unsupported slash commands or operator retries', () => {
  const s = instance(), instructions = s.runtime.instructionPreview(s.runtime.newConversation().id);
  expect(instructions).toContain('Do not delegate everyday tasks to slash commands, CLI or scripts');
  expect(s.runtime.extensions.instructions({ ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: '', runId: '', source, mode: 'foreground' }, new Set(['documents']))).toContain('Pending/processing is not failure');
  expect(instructions).not.toContain('owner CLI knowledge retry');
});

it.each(['text-only', 'unconfigured', 'unknown'] as const)('preserves images without inference or provider fallback when the selected model is %s', async scenario => {
  const s = instance(), model = s.runtime.models.model();
  if (scenario === 'text-only') vi.spyOn(s.runtime.models, 'model').mockReturnValue({ ...model, input: ['text'] });
  if (scenario === 'unconfigured') {
    s.config.model = { provider: 'openai', id: 'gpt-4o-mini' };
    expect(await s.runtime.models.capabilities()).toMatchObject({ images: true, authentication: 'unconfigured' });
  }
  if (scenario === 'unknown') s.config.model = { provider: 'not-a-provider', id: 'not-a-model' };
  const complete = vi.spyOn(s.runtime.models, 'complete'), doc = await image(s);
  await s.runtime.knowledge.work();
  expect(complete).not.toHaveBeenCalled(); expect(s.faux.state.callCount).toBe(0);
  expect(s.runtime.knowledge.revision(doc.id).extraction).toBe('needs_ocr');
  expect(s.runtime.knowledge.original(doc.id).bytes).toEqual(bytes);
});

it.each(['network', 'empty', 'oversized', 'incomplete'] as const)('retains originals and never automatically replays a %s vision failure', async kind => {
  const s = instance(), doc = await image(s), complete = vi.spyOn(s.runtime.models, 'complete');
  if (kind === 'network') complete.mockRejectedValue(new Error('PRIVATE provider detail'));
  else if (kind === 'incomplete') s.faux.appendResponses([fauxAssistantMessage([fauxText('Partial')], { stopReason: 'length' })]);
  else complete.mockResolvedValue(fauxAssistantMessage([fauxText(kind === 'empty' ? ' ' : 'x'.repeat(16_001))]));
  await s.runtime.knowledge.work(); await s.runtime.knowledge.work();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(s.runtime.knowledge.read(doc.id)).toMatchObject({ extraction: 'failed', text: null, conversion: { error: { code: 'vision_uncertain', message: expect.stringContaining('not automatically replayed') } } });
  expect(s.runtime.knowledge.revision(doc.id).conversion).not.toContain('PRIVATE');
  expect(s.runtime.knowledge.original(doc.id).bytes).toEqual(bytes);
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models);
  await s.runtime.knowledge.work(); expect(complete).toHaveBeenCalledTimes(1);
  const services = new DocumentServices(s.runtime, { ownerId: s.config.ownerId, instanceId: s.config.instanceId, conversationId: '', runId: 'vision-retry', source, mode: 'foreground' }, () => false);
  await expect(services.operate({ action: 'retry', id: doc.id }, undefined, 'retry')).rejects.toThrow('requires explicit owner authorization');
  complete.mockResolvedValue(fauxAssistantMessage([fauxText('A readable picture after explicit retry.')]));
  await s.runtime.knowledge.operate({ action: 'retry', id: doc.id }); await s.runtime.knowledge.work();
  expect(complete).toHaveBeenCalledTimes(2); expect(s.runtime.knowledge.read(doc.id).text).toContain('after explicit retry');
});

it('recovers a committed vision intention after a crash without another inference request', async () => {
  const s = instance(), doc = await image(s);
  vi.spyOn(s.runtime.models, 'complete').mockRejectedValue(new Error('Lost acknowledgment'));
  await s.runtime.knowledge.work();
  s.store.run("UPDATE document_jobs SET status='running' WHERE document_id=?", doc.id);
  await s.runtime.close(); s.runtime = new Runtime(s.store, s.runtime.models);
  const complete = vi.spyOn(s.runtime.models, 'complete'); complete.mockClear();
  expect(await documentService(s).operate({ action: 'read', id: doc.id }, undefined, 'recovered-read')).toMatchObject({ extraction: 'failed' });
  expect(complete).not.toHaveBeenCalled();
  expect(s.runtime.knowledge.read(doc.id)).toMatchObject({ extraction: 'failed', conversion: { error: { code: 'vision_uncertain' } } });
});

it.each(['forget', 'replace', 'abort'] as const)('does not publish a late description after %s', async action => {
  const s = instance(), doc = await image(s), controller = new AbortController();
  let finish!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
  vi.spyOn(s.runtime.models, 'complete').mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
  const work = s.runtime.knowledge.work(controller.signal); await waitFor(() => !!finish);
  await expect(s.runtime.knowledge.operate({ action: 'retry', id: doc.id })).rejects.toThrow('still running');
  if (action === 'forget') await s.runtime.knowledge.operate({ action: 'forget', id: doc.id });
  else if (action === 'replace') {
    const replacement = s.runtime.media.save(Buffer.from('Replacement text'), 'new.txt', 'text/plain');
    await s.runtime.knowledge.replaceOriginal(doc.id, 1, replacement);
  } else controller.abort();
  finish(fauxAssistantMessage([fauxText('LATE-PRIVATE-DESCRIPTION')])); await work;
  expect(s.store.all<any>('SELECT markdown FROM document_revisions').some(row => row.markdown?.includes('LATE-PRIVATE-DESCRIPTION'))).toBe(false);
  expect(s.store.get<any>('SELECT status FROM document_jobs WHERE document_id=? AND revision=1', doc.id).status).toBe('cancelled');
});

it('rechecks source existence before submitting pixels after asynchronous authentication', async () => {
  const s = instance(), doc = await image(s), complete = vi.spyOn(s.runtime.models, 'complete');
  const capabilities = await s.runtime.models.capabilities();
  vi.spyOn(s.runtime.models, 'capabilities').mockImplementation(async () => { await s.runtime.knowledge.operate({ action: 'forget', id: doc.id }); return capabilities; });
  await s.runtime.knowledge.work(); expect(complete).not.toHaveBeenCalled();
});

it('keeps ephemeral image inspection volatile and creates no description job or durable text', async () => {
  const s = instance(), c = s.runtime.newConversation('Volatile image', true), complete = vi.spyOn(s.runtime.models, 'complete');
  const attachment = s.runtime.media.save(bytes, 'image.png', 'image/png', c.id, true);
  s.faux.appendResponses([fauxAssistantMessage([fauxText('Volatile description.')])]);
  const run = await s.runtime.channels.ingest('terminal', { requestId: 'ephemeral-image', conversationId: c.id, text: 'Inspect', attachments: [attachment] }, source, 'ephemeral');
  await waitFor(() => s.runtime.run(run.id).status === 'completed');
  expect(complete).not.toHaveBeenCalled();
  for (const table of ['documents', 'document_jobs', 'attachments', 'messages', 'media_derivatives']) expect(s.store.all(`SELECT * FROM ${table}`)).toEqual([]);
});

it('backs up image descriptions with originals and erases them through old-backup restore', async () => {
  const s = instance(), doc = await image(s);
  s.faux.appendResponses([fauxAssistantMessage([fauxText('BACKED-UP-IMAGE: a violet package.')])]);
  await s.runtime.knowledge.work();
  const snapshot = await backup(s.store), external = mkdtempSync(join(tmpdir(), 'pikobot-image-backup-'));
  cpSync(snapshot.path, external, { recursive: true });
  try {
    await s.runtime.close(); s.store.close(); await restore(s.root, external, true);
    s.store = new Store(s.root, s.config); s.runtime = new Runtime(s.store, s.runtime.models);
    expect(s.runtime.knowledge.read(doc.id).text).toContain('BACKED-UP-IMAGE');
    expect(s.runtime.knowledge.original(doc.id).bytes).toEqual(bytes);
    await s.runtime.knowledge.operate({ action: 'forget', id: doc.id });
    await s.runtime.close(); s.store.close(); await restore(s.root, external, true);
    s.store = new Store(s.root, s.config); s.runtime = new Runtime(s.store, s.runtime.models);
    expect(() => s.runtime.knowledge.read(doc.id)).toThrow('not found');
    expect(s.store.get<any>('SELECT markdown,conversion FROM document_revisions WHERE document_id=?', doc.id)).toEqual({ markdown: null, conversion: null });
    expect(existsSync(join(s.root, 'knowledge/objects', doc.id))).toBe(false);
    expect(s.store.all('SELECT * FROM attachments')).toEqual([]);
  } finally { rmSync(external, { recursive: true, force: true }); }
});
