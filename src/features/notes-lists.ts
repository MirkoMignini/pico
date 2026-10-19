import { Type } from 'typebox';
import { ListToolSchema, validateList, knowledgeActionParameters } from '../knowledge.js';
import { object, validate } from '../contracts.js';
import type { ExtensionAPI, ExtensionContext } from '../extensions.js';
import { jsonTool } from './tools.js';

const notesSchema = object({ action: Type.Union([Type.Literal('create'), Type.Literal('edit')]),
  ...Object.fromEntries(Object.entries({ ...Type.Omit(knowledgeActionParameters('create'), ['submission']).properties, ...knowledgeActionParameters('edit').properties }).map(([key, value]) => [key, Type.Optional(value)])) });

export default function notesLists(pikobot: ExtensionAPI): void {
  pikobot.on('instructions', () => 'Saved note/list contents come from canonical knowledge, not personal memory, remembered requests or assistant replies. Inspect historical revisions and original receipts before claiming removal; a failed addition was never saved. Do not automatically replay failures. Manage notes/lists from owner needs and natural follow-ups without mandatory confirmation, explicit save wording, command words or drafting sessions, even if older history says otherwise. Preserve useful supplied context and document IDs; never invent facts or treat annotations as independent evidence. Markdown bodies exclude separately supplied titles; empty lists need no placeholder. Pikobot assigns stable IDs. For a request to create and share a list, load family and use family create with the named member; unqualified sharing means read and write, explicit read-only remains read-only. Ordinary lists create stays private. Dates in notes do not schedule notifications.');
  jsonTool(pikobot, 'notes', 'Create prose notes with title/markdown; edit with id/expectedRevision/find/replace. Preserve source references and distinguish observations from inferred annotations. Reuse fresh canonical text/revisions; read missing spans via documents or reread after revision conflicts. Use lists for checklist items.', notesSchema, async (args, context) => {
    const schema = args.action === 'create' ? Type.Omit(knowledgeActionParameters('create'), ['submission']) : knowledgeActionParameters('edit');
    const { action, ...parameters } = args; validate(schema, parameters);
    return context.services.documents({ action, ...parameters });
  });
  jsonTool(pikobot, 'lists', 'Manage saved lists. Read by ID or exact unique title; clarify duplicates. create: title/items (may be empty); for creation shared with a member use family create instead. add: id/items only, no expectedRevision; atomic append preserves entries, never rewrite a list to add items. update: id/expectedRevision/itemId and text/completed; mark obtained/done items completed=true. remove: id/expectedRevision/itemId; delete: id/expectedRevision. Reuse fresh canonical IDs/revisions; reread only missing items or after conflicts. Only successful mutation receipts establish saved changes, not read receipts; counts are revision-scoped and paginated.', ListToolSchema, async (a, context) => {
    validateList(a);
    const documents = context.services.documents;
    if (a.action === 'catalog') return documents({ ...a, action: 'note_catalog' });
    if (a.action === 'read') return { ...await view(context, a), effect: 'read' };
    const actions: Record<string, string> = { create: 'create_list', add: 'append_items', update: 'checklist', remove: 'remove_item', delete: 'delete_list' };
    const result = await documents({ ...a, action: actions[a.action]! });
    if (a.action === 'delete') return { id: a.id, effect: 'deleted', result };
    const effects: Record<string, string> = { create: 'created', add: 'added', update: 'updated', remove: 'removed' };
    return { ...await view(context, { id: result.id, revision: result.current_revision }), effect: effects[a.action] };
  });
}
async function view(context: ExtensionContext, a: Record<string, any>) {
  const documents = context.services.documents;
  const id = a.id ?? (await documents({ action: 'note_resolve', title: a.title })).id;
  const evidence = await documents({ action: 'read', id, ...(a.revision !== undefined ? { revision: a.revision } : {}) });
  if (evidence.kind !== 'note') throw new Error('Only authored notes/checklists can be managed as lists');
  if (!evidence.sourceId || !evidence.citation) throw new Error('Verified authored list evidence required');
  const items = await documents({ action: 'items', id, revision: evidence.revision, ...Object.fromEntries(['offset', 'limit', 'completed'].filter(key => a[key] !== undefined).map(key => [key, a[key]])) });
  return { id, kind: evidence.kind, title: evidence.title, sourceId: evidence.sourceId, citation: evidence.citation, ...items };
}
