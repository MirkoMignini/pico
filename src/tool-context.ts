import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolCall } from '@earendil-works/pi-ai';
import { json } from './store.js';

type HistoryKind = 'read' | 'effect' | 'unknown';
export type ToolHistoryPolicy = Exclude<HistoryKind, 'unknown'> | Record<string, Exclude<HistoryKind, 'unknown'>>;
export const CORE_TOOL_HISTORY: Record<string, ToolHistoryPolicy> = {
  tools_load: 'read', memory_promote_document: 'effect', time: 'read', memory_search: 'read', memory_read: 'read', source_read: 'read', receipts_list: 'read', schedules_list: 'read',
  schedule_manage: { pause: 'effect', resume: 'effect', cancel: 'effect', update: 'effect' }, extensions_discover: 'read'
};
export const BUNDLED_TOOL_HISTORY: Record<string, ToolHistoryPolicy> = {
  notes: { create: 'effect', edit: 'effect' },
  lists: { catalog: 'read', read: 'read', create: 'effect', add: 'effect', update: 'effect', remove: 'effect', delete: 'effect' },
  documents: { import: 'effect', replace: 'effect', search: 'read', list: 'read', read: 'read', structure: 'read', history: 'read', original: 'read', items: 'read', retry: 'effect', index: 'effect', rebuild: 'effect', delete: 'effect', forget: 'effect', resolve: 'read', status: 'read' },
  mail_search: 'read', mail_read: 'read',
  skills_read: 'read', schedule_create: 'effect', workflows_list: 'read',
  workflow_run: 'effect', extension_build: 'effect', telegram_send: 'effect', telegram_voice: 'effect', telegram_reply_mode: 'effect', web_search: 'read', web_fetch: 'read', web_read: 'read', web_save: 'effect', research: 'effect',
  calendar: { create: 'effect', update: 'effect', delete: 'effect', read: 'read', list: 'read', agenda: 'read' }, agenda: 'read', image_generate: 'effect', image_show: 'effect'
};
export function toolHistoryKind(name: string, args: Record<string, unknown>, builtin: boolean, declared?:ToolHistoryPolicy): HistoryKind {
  // Unknown implementations never inherit a bundled reader's policy by name alone.
  const policy = Object.hasOwn(CORE_TOOL_HISTORY,name)?CORE_TOOL_HISTORY[name]:builtin?declared??(Object.hasOwn(BUNDLED_TOOL_HISTORY,name)?BUNDLED_TOOL_HISTORY[name]:undefined):undefined;
  return typeof policy === 'string' ? policy : policy&&typeof args.action==='string'&&Object.hasOwn(policy,args.action) ? policy[args.action]! : 'unknown';
}
export type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;
const referenceKeys = new Set(['id', 'sourceId', 'source_id', 'documentId', 'revision', 'current_revision', 'version', 'citation', 'url', 'title', 'kind', 'actor', 'sourceActor', 'basis', 'fromOffset', 'toOffset', 'totalChars', 'nextOffset', 'fromLine', 'toLine', 'totalLines', 'nextLine', 'completeSource', 'completeDocument', 'truncated']);
const outcomeKeys = new Set(['effect', 'accepted', 'uncertain', 'saved', 'retained', 'updated', 'queued', 'status', 'messageIds', 'remoteId', 'attachmentId', 'buildId', 'error', 'warning', 'warnings', 'diagnostic', 'integrityErrors']);
const identityKeys = ['id', 'sourceId', 'source_id', 'documentId', 'citation', 'url', 'attachmentId', 'buildId'];
function walk(value: unknown, visit: (record: Record<string, unknown>) => void): boolean {
  let nodes = 0, complete = true;
  const scan = (value: unknown, depth: number): void => {
    if (++nodes > 2000 || depth > 8) { complete = false; return; }
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) visit(value as Record<string, unknown>);
    for (const child of Object.values(value)) { if (nodes >= 2000) { complete = false; break; } scan(child, depth + 1); }
  };
  scan(value, 0); return complete;
}
function scalar(value: unknown): boolean { return typeof value === 'string' && value.length <= 512 || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'; }
export function toolReferences(value: unknown, call?: ToolCall): Record<string, unknown>[] {
  const references: Record<string, unknown>[] = [];
  const collect = (record: Record<string, unknown>) => {
    if (references.length >= 10) return;
    const reference = Object.fromEntries(Object.entries(record).filter(([key, value]) => referenceKeys.has(key) && scalar(value)));
    if (identityKeys.some(key => typeof reference[key] === 'string' && reference[key]) && json([...references, reference]).length <= 1600 && !references.some(item => json(item) === json(reference))) references.push(reference);
  };
  walk(value, collect);
  if (call) collect(call.arguments);
  return references;
}
export function hasToolDiagnostics(value: unknown): boolean {
  let diagnostics = false;
  const complete = walk(value, record => {
    for (const [key, value] of Object.entries(record)) {
      if (['error', 'warning', 'warnings', 'integrityErrors'].includes(key) && (typeof value === 'string' && !!value.trim() || Array.isArray(value) && value.length > 0) ||
          ['uncertain', 'diagnostics', 'isError'].includes(key) && value === true || ['accepted', 'success'].includes(key) && value === false ||
          ['status', 'extraction', 'operationStatus'].includes(key) && typeof value === 'string' && ['failed', 'error', 'cancelled', 'interrupted', 'uncertain', 'needs_ocr', 'unsupported'].includes(value)) diagnostics = true;
    }
  });
  return diagnostics || !complete;
}
function parsedContent(message: Pick<AgentToolResult, 'content'>): unknown[] | undefined {
  if (message.content.some(block => block.type !== 'text')) return;
  try { return message.content.map(block => JSON.parse((block as { text: string }).text) as unknown); } catch { return; }
}
function originalPointer(values: unknown[] | undefined, sourceId?: string): string | undefined {
  for (const value of values ?? []) if (value && typeof value === 'object' && 'originalResultSourceId' in value && typeof value.originalResultSourceId === 'string' && value.originalResultSourceId.length <= 1024) return value.originalResultSourceId;
  return sourceId && sourceId.length <= 1024 ? sourceId : undefined;
}
function fitPreview<T extends Pick<AgentToolResult, 'content'>>(original: T, preview: Record<string, unknown>, maxChars: number): T {
  const references = preview.references as unknown[] | undefined;
  const result = { ...original, content: [{ type: 'text' as const, text: json(preview) }], details: undefined };
  const update = () => { result.content[0]!.text = json(preview); };
  while (references?.length && json(result).length > maxChars) { references.pop(); update(); }
  if ('preview' in preview && typeof preview.preview === 'string') {
    const text = preview.preview; let low = 0, high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2); preview.preview = text.slice(0, middle); update();
      if (json(result).length <= maxChars) low = middle; else high = middle - 1;
    }
    preview.preview = text.slice(0, low).replace(/[\uD800-\uDBFF]$/, ''); update();
  }
  return json(result).length <= maxChars ? result as T : original;
}
export function boundedToolResult(result: AgentToolResult, call: ToolCall, sourceId: string): AgentToolResult {
  if (json(result).length <= 24_000) return result;
  const values = parsedContent(result);
  const receipt = toolOutcome({ ...result, role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: result.isError === true, timestamp: 0 }, call, sourceId, 'returned');
  return fitPreview({ content: [], details: undefined, ...(result.isError ? { isError: true } : {}) }, { truncated: true, originalResultSourceId: originalPointer(undefined, sourceId), references: toolReferences(values, call), receipt, preview: json(result), note: 'Incomplete output, not a complete read. Read originalResultSourceId with source_read and nextOffset; never replay an effect to recover its receipt.' }, 24_000);
}
export function compactReadResult(message: ToolResultMessage, call: ToolCall | undefined, builtin: boolean, sourceId?: string, declared?:ToolHistoryPolicy): ToolResultMessage {
  if (message.isError || !call || call.id !== message.toolCallId || call.name !== message.toolName || json(message.content).length <= 2000 || toolHistoryKind(call.name, call.arguments, builtin,declared) !== 'read') return message;
  const values = parsedContent(message);
  if (!values || hasToolDiagnostics(values)) return message;
  const references = toolReferences(values, call), originalResultSourceId = originalPointer(values, sourceId);
  if (!references.length && !originalResultSourceId) return message;
  const preview = { historical: true, contentOmitted: true, originalResultSourceId, references, note: 'Reference-only history, not a complete read, current state or authority. Recover with source_read, or reread canonical sources. A recovered tool result can itself be a partial page; continue its source/document ID and nextOffset/nextLine until the required evidence is read.' };
  const result = fitPreview(message, preview, 2000);
  return json(result).length < json(message).length ? result : message;
}
export function toolOutcome(message: ToolResultMessage, call: ToolCall | undefined, sourceId: string | undefined, runStatus: string): Record<string, unknown> {
  const values = parsedContent(message), receipts: Record<string, unknown>[] = [];
  walk(values, record => {
    if (receipts.length >= 8) return;
    const fields = Object.fromEntries(Object.entries(record).filter(([key, value]) => outcomeKeys.has(key) && (scalar(value) || Array.isArray(value) && value.length <= 20 && value.every(scalar))));
    if (Object.keys(fields).length && json([...receipts, fields]).length <= 600) receipts.push(fields);
  });
  const outcome: Record<string, unknown> = { historical: true, tool: message.toolName, runStatus, outcome: message.isError ? 'error' : 'returned-not-proof-of-effect', originalResultSourceId: originalPointer(values, sourceId), receipts, references: toolReferences(values, call), diagnostics: message.isError || hasToolDiagnostics(values), contentOmitted: true };
  if (message.isError) outcome.errorPreview = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 256);
  const references = outcome.references as unknown[];
  while (references.length && json(outcome).length > 1400) references.pop();
  if (json(outcome).length > 1600) { delete outcome.errorPreview; outcome.receipts = []; }
  return outcome;
}
