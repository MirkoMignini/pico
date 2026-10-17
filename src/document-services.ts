import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { KnowledgeSchema, ListSchema, knowledgeActionParameters, type KnowledgeOrigin } from './knowledge.js';
import { object, validate, type Envelope } from './contracts.js';
import type { Runtime } from './runtime.js';

const listAction = (action: string, serviceAction: string) => {
  const schema = (ListSchema.anyOf as import('typebox').TObject[]).find(schema => Value.Check(schema.properties.action!, action))!;
  return object({ ...Type.Omit(schema, ['action']).properties, action: Type.Literal(serviceAction) });
};
const schema = Type.Union([
  ...(KnowledgeSchema.anyOf as import('typebox').TObject[]).filter(branch => !Value.Check(branch.properties.action!, 'create') && !Value.Check(branch.properties.action!, 'import')),
  object({ action: Type.Literal('create'), ...Type.Omit(knowledgeActionParameters('create'), ['submission']).properties }),
  object({ action: Type.Literal('import'), ...Type.Omit(knowledgeActionParameters('import'), ['submission']).properties, submission: Type.Optional(knowledgeActionParameters('import').properties.submission!) }),
  listAction('catalog', 'note_catalog'), listAction('create', 'create_list'), listAction('add', 'append_items'),
  listAction('remove', 'remove_item'), listAction('delete', 'delete_list'),
  object({ action: Type.Literal('note_resolve'), title: Type.String({ minLength: 1, maxLength: 1000 }) })
]);
const writes = new Set(['import', 'replace', 'create', 'edit', 'checklist', 'retry', 'index', 'rebuild', 'delete', 'forget', 'create_list', 'append_items', 'remove_item', 'delete_list']);

export class DocumentServices {
  constructor(private runtime: Runtime, private context: Envelope, private readOnly: () => boolean) {}
  async operate(raw: unknown, signal: AbortSignal | undefined, callId: string): Promise<any> {
    const action = typeof raw === 'object' && raw !== null ? (raw as { action?: unknown }).action : undefined;
    const branch = (schema.anyOf as import('typebox').TObject[]).find(candidate => Value.Check(candidate.properties.action!, action));
    const a = validate<Record<string, any>>(branch ?? schema, raw), { store, knowledge } = this.runtime, context = this.context;
    const input = store.get<{ id: string }>("SELECT id FROM messages WHERE run_id=? AND role='user'", context.runId);
    const origin: KnowledgeOrigin = { author: `assistant:${store.config.instanceId}`, channel: context.source.channel, runId: context.runId, sourceId: input?.id };
    if (writes.has(a.action) && (this.readOnly() || !context.source.trustedOwner || context.mode !== 'foreground')) throw new Error('This execution mode cannot persist knowledge or lists');
    let result: any;
    switch (a.action) {
      case 'note_catalog': {
        const offset = a.offset ?? 0, limit = a.limit ?? 20, total = store.get<{ n: number }>("SELECT count(*) n FROM documents WHERE kind='note' AND deleted_at IS NULL")!.n;
        return { total, offset, nextOffset: offset + limit < total ? offset + limit : null, lists: store.all("SELECT id,title,current_revision revision FROM documents WHERE kind='note' AND deleted_at IS NULL ORDER BY received_at,id LIMIT ? OFFSET ?", limit, offset) };
      }
      case 'note_resolve': {
        const matches = store.all<{ id: string }>("SELECT id FROM documents WHERE kind='note' AND deleted_at IS NULL AND title=? COLLATE NOCASE", a.title);
        if (matches.length !== 1) throw new Error(matches.length ? 'List title is ambiguous; use an ID from catalog' : 'List title not found in this instance');
        return knowledge.document(matches[0]!.id);
      }
      case 'import': {
        const existing = a.submission === undefined && store.get<{ id: string }>('SELECT id FROM documents WHERE attachment_id=? AND deleted_at IS NULL ORDER BY received_at DESC LIMIT 1', a.attachmentId);
        if (existing) { knowledge.original(existing.id); result = knowledge.document(existing.id); }
        else result = await knowledge.operate({ ...a, submission: a.submission ?? `import:${context.runId}:${callId}` }, signal, origin);
        break;
      }
      case 'create_list': result = knowledge.createNote(a.title, a.items.map((text: string) => `- [ ] ${text}`).join('\n'), `list:${context.runId}:${callId}`, origin); break;
      case 'append_items': result = knowledge.appendItems(a.id, a.items, origin); break;
      case 'remove_item': result = knowledge.removeItem(a.id, a.expectedRevision, a.itemId, origin); break;
      case 'delete_list': {
        const doc = knowledge.document(a.id);
        if (doc.kind !== 'note') throw new Error('Only authored lists can be deleted with lists');
        if (doc.current_revision !== a.expectedRevision) throw new Error('Revision conflict; reread before deleting');
        return this.runtime.deleteKnowledge(doc.id, false, context.runId);
      }
      case 'delete': case 'forget': return this.runtime.deleteKnowledge(a.id, a.action === 'forget', context.runId, a.cascade === true);
      case 'read': {
        result = knowledge.read(a.id, a.revision, a.fromLine, a.maxLines, a.fromOffset, a.maxChars);
        if (!this.readOnly() && context.source.trustedOwner && context.mode === 'foreground' && result.extraction === 'pending' && result.document && result.revision === result.document.current_revision) {
          await knowledge.work(signal, { id: a.id, revision: result.revision });
          signal?.throwIfAborted();
          result = knowledge.read(a.id, a.revision, a.fromLine, a.maxLines, a.fromOffset, a.maxChars);
        }
        break;
      }
      case 'original': {
        const original = knowledge.original(a.id, a.revision, a.assetId);
        const revision = a.revision ?? knowledge.document(a.id).current_revision;
        result = { documentId: a.id, revision, sourceId: `document:${a.id}:r${revision}`, name: original.name, mime: original.mime, hash: original.hash, bytes: original.bytes.length, note: 'Download original via owner knowledge RPC/CLI; binary content is not text evidence' };
        break;
      }
      default:
        if (a.action === 'create') a.submission = `note:${context.runId}:${callId}`;
        if (a.action === 'search' && context.mode === 'ephemeral') a.mode = 'lexical';
        result = await knowledge.operate(a, signal, origin);
    }
    if (context.mode !== 'ephemeral') for (const sourceId of new Set([...(result.results ?? []).map((item: { sourceId?: string }) => item.sourceId), result.sourceId].filter(Boolean))) store.linkSource(context.runId, sourceId as string);
    return result;
  }
}
