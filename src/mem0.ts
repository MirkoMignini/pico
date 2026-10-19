import { Memory as Mem0, type VectorStore, type VectorStoreResult, type SearchFilters, type Message, type LLM } from 'mem0ai/oss';
import type { SQLInputValue } from 'node:sqlite';
import { Store, json } from './store.js';
import { ModelAccess, assistantText } from './models.js';
import type { EmbeddingProvider, MemorySearch } from './contracts.js';

export type MemoryFilters = Omit<MemorySearch, 'query' | 'limit'>;
const stopWords = new Set('a an the i me my you your we our it is are was were do does did what which who when where why how in on at to from for of and or with as this that il lo la gli le un una di da del della in a al alla e o con che chi cosa quale quando dove come io mio mia mi è sono era non'.split(' '));
interface Entry { id: string; recordId?: string; collection: string; vector: number[]; payload: Record<string, any> }
interface Row { id: string; kind: string; text: string; source_id: string; event_at: number; entity: string | null }

// Mem0 owns extraction and ranking; this adapter keeps its effects in Pikobot's authoritative transaction.
export class Mem0Operation {
  readonly staged = new Map<string, Entry>();
  error?: unknown;
  degraded = false;
  constructor(readonly store: Store, readonly embeddings?: EmbeddingProvider, readonly signal?: AbortSignal,
    readonly filters: MemoryFilters = {}, readonly query = '') {}
  check(): void { this.signal?.throwIfAborted(); if (this.error) throw this.error; }
  get model(): string { return this.embeddings?.model ?? 'disabled'; }
  get dimensions(): number { return this.embeddings?.dimensions ?? 1; }
  get version(): string { return this.embeddings?.version ?? '1'; }
  async embed(texts: string[], purpose: 'query' | 'passage', fallback = false): Promise<number[][]> {
    this.check();
    if (!this.embeddings) return texts.map(() => [0]);
    try {
      const result = await this.embeddings.embed(texts, this.signal, purpose);
      this.check();
      if (result.length !== texts.length || result.some(vector => vector.length !== this.dimensions || !vector.every(Number.isFinite))) throw new Error('Embedding dimension/data/count mismatch');
      return result;
    } catch (error) {
      this.signal?.throwIfAborted();
      if (!fallback) { this.error = error; throw error; }
      this.degraded = true;
      return texts.map(() => Array(this.dimensions).fill(0) as number[]);
    }
  }
  create(models?: ModelAccess, instructions?: string, inspect?: (text: string) => string): Mem0 {
    const llm: LLM = { generateChat: async () => { throw new Error('Mem0 chat is disabled; use Pikobot agent-core'); }, generateResponse: async (messages: Message[]) => {
      this.check();
      if (!models) throw new Error('Extraction model unavailable');
      const response = await models.complete({ systemPrompt: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'),
        messages: messages.filter(m => m.role !== 'system').map(m => ({ role: 'user' as const, content: String(m.content), timestamp: Date.now() })) }, this.signal, models.config.model, { json: true, maxTokens: 8192 });
      this.check();
      const text = assistantText(response);
      return inspect ? inspect(text) : text;
    } };
    return new Mem0({ disableHistory: true, customInstructions: instructions,
      embedder: { provider: 'pikobot', config: { apiKey: '', model: {
        embed: async (text: string, action: string) => (await this.embed([text], action === 'search' ? 'query' : 'passage', !models))[0]!,
        embedBatch: (texts: string[], action: string) => this.embed(texts, action === 'search' ? 'query' : 'passage', !models)
      } } },
      llm: { provider: 'pikobot', config: { apiKey: '', client: llm } },
      vectorStore: { provider: 'pikobot', config: { collectionName: 'memories', dimension: this.dimensions,
        instance: (name: string) => new PikobotVectorStore(this, name.endsWith('_entities') ? 'entities' : 'memories') } }
    });
  }
  where(): { sql: string; args: SQLInputValue[] } {
    const f = this.filters;
    return { sql: `r.event_at>=? AND r.event_at<=? AND (? IS NULL OR r.entity=?) AND
      NOT EXISTS(SELECT 1 FROM documents d WHERE r.source_id LIKE 'document:'||d.id||':r%' AND (d.deleted_at IS NOT NULL OR (?=0 AND r.source_id!='document:'||d.id||':r'||d.current_revision))) AND
      ((r.kind!='memory' AND ? IS NULL AND ? IS NULL AND ? IS NULL AND ?=0) OR EXISTS(SELECT 1 FROM memories m WHERE m.id=r.id AND
        (m.status IN('current','stored') OR (?=1 AND m.status='superseded')) AND
        (?=1 OR m.valid_until IS NULL OR m.valid_until>?) AND (? IS NULL OR m.scope IN('global',?)) AND
        (? IS NULL OR m.kind=?) AND (? IS NULL OR m.basis=?) AND
        NOT EXISTS(SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS(SELECT 1 FROM memory_tags t WHERE t.memory_id=m.id AND t.tag=wanted.value))))`,
      args: [f.since ?? 0, f.until ?? Date.now(), f.entity ?? null, f.entity ?? null, f.history ? 1 : 0, f.scope ?? null,
        f.kind ?? null, f.basis ?? null, f.tags?.length ?? 0, f.history ? 1 : 0, f.history ? 1 : 0, Date.now(), f.scope ?? null, f.scope ?? null,
        f.kind ?? null, f.kind ?? null, f.basis ?? null, f.basis ?? null, json(f.tags ?? [])] };
  }
  payload(row: Row): Record<string, any> {
    const memory = row.kind === 'memory' ? this.store.get<Record<string, unknown>>('SELECT kind AS memoryKind,scope,basis,status,valid_until AS validUntil FROM memories WHERE id=?', row.id) : undefined;
    const tags = row.kind === 'memory' ? this.store.all<{tag:string}>('SELECT tag FROM memory_tags WHERE memory_id=? ORDER BY tag', row.id).map(row => row.tag) : [];
    return { user_id: this.store.config.ownerId, recordId: row.id, data: row.text, sourceId: row.source_id, eventAt: row.event_at, entity: row.entity, kind: row.kind, ...memory, tags };
  }
  lexical(query: string, topK: number): VectorStoreResult[] {
    this.check();
    const tokens = [...new Set(query.match(/[\p{L}\p{N}_@.-]+/gu) ?? [])].filter(token => !stopWords.has(token.toLowerCase())).slice(0, 24);
    if (!tokens.length) return [];
    const { sql, args } = this.where();
    return this.store.all<Row & { rank: number }>(`SELECT r.*,bm25(retrieval_fts) rank FROM retrieval_fts JOIN retrieval r ON r.id=retrieval_fts.id
      WHERE retrieval_fts MATCH ? AND ${sql} ORDER BY rank LIMIT ?`, tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR '), ...args, topK)
      .map(row => ({ id: row.id, payload: this.payload(row), score: -row.rank }));
  }
  commit(): void {
    this.check();
    this.store.transaction(() => {
      for (const entry of this.staged.values()) {
        if (entry.collection === 'memories' && (!entry.recordId || !this.store.get('SELECT id FROM retrieval WHERE id=? AND text=?', entry.recordId, entry.payload.indexedText ?? entry.payload.data))) continue;
        if (entry.collection === 'entities') {
          entry.payload.linkedMemoryIds = (entry.payload.linkedMemoryIds ?? []).map((id: string) => this.staged.get(id)?.recordId ?? id)
            .filter((id: string) => !!this.store.get('SELECT id FROM retrieval WHERE id=?', id));
          if (!entry.payload.linkedMemoryIds.length) continue;
        }
        const vector = Buffer.from(new Float32Array(entry.vector).buffer);
        this.store.run('INSERT OR REPLACE INTO mem0_vectors VALUES(?,?,?,?,?,?,?,?)', entry.id, entry.recordId ?? null, entry.collection,
          this.model, this.dimensions, this.version, vector, json(entry.payload));
      }
    });
  }
}

class PikobotVectorStore implements VectorStore {
  constructor(readonly op: Mem0Operation, readonly collection: string) {}
  async initialize(): Promise<void> { this.op.check(); }
  async getUserId(): Promise<string> { return this.op.store.config.ownerId; }
  async setUserId(): Promise<void> {}
  private matches(payload: Record<string, any>, filters?: SearchFilters): boolean {
    if (payload.user_id !== this.op.store.config.ownerId) return false;
    return Object.entries(filters ?? {}).every(([key, value]) => payload[key] === value);
  }
  async insert(vectors: number[][], ids: string[], payloads: Record<string, any>[]): Promise<void> {
    this.op.check();
    if (vectors.length !== ids.length || ids.length !== payloads.length || vectors.some(v => v.length !== this.op.dimensions || !v.every(Number.isFinite)) || payloads.some(p => !this.matches(p))) {
      this.op.error = new Error('Invalid Mem0 vector batch/ownership'); throw this.op.error;
    }
    ids.forEach((id, i) => this.op.staged.set(id, { id, collection: this.collection, recordId: payloads[i]!.recordId, vector: vectors[i]!, payload: payloads[i]! }));
  }
  async keywordSearch(query: string, topK = 10): Promise<VectorStoreResult[]> { return this.collection === 'memories' ? this.op.lexical(query, topK) : []; }
  async search(query: number[], topK = 10, filters?: SearchFilters): Promise<VectorStoreResult[]> {
    this.op.check();
    if (query.length !== this.op.dimensions || !query.every(Number.isFinite)) throw new Error('Invalid Mem0 query vector');
    const { sql, args } = this.op.where();
    const statement = this.op.store.db.prepare(this.collection === 'memories' ? `SELECT v.rowid cursor,v.id,v.vector,v.payload,r.id record_id FROM mem0_vectors v JOIN retrieval r ON r.id=v.record_id
      WHERE v.collection='memories' AND v.model=? AND v.dimensions=? AND v.version=? AND ${sql} AND v.rowid>? ORDER BY v.rowid LIMIT 16` : `SELECT rowid cursor,id,vector,payload FROM mem0_vectors WHERE collection='entities' AND model=? AND dimensions=? AND version=? AND rowid>? ORDER BY rowid LIMIT 16`);
    const ranked: VectorStoreResult[] = [];
    const similarity = (vector: number[]) => {
      let dot = 0, a = 0, b = 0;
      for (let i = 0; i < query.length; i++) { dot += query[i]! * vector[i]!; a += query[i]! ** 2; b += vector[i]! ** 2; }
      return a && b ? dot / Math.sqrt(a * b) : 0;
    };
    const rank = (id: string, vector: number[], payload: Record<string, any>) => {
      if (!this.matches(payload, filters)) return;
      const score = similarity(vector);
      if (score <= 0.2) return;
      ranked.push({ id, payload, score }); ranked.sort((x, y) => y.score! - x.score!); if (ranked.length > topK) ranked.pop();
    };
    let cursor = 0;
    while (true) {
      this.op.check();
      // Release SQLite statements before yielding so erasure/backup can checkpoint WAL.
      const rows = statement.all(this.op.model, this.op.dimensions, this.op.version, ...(this.collection === 'memories' ? args : []), cursor);
      for (const row of rows) {
        this.op.check();
        const vector = Array.from(new Float32Array(Uint8Array.from(row.vector as Uint8Array).buffer));
        rank(String(row.record_id ?? row.id), vector, JSON.parse(String(row.payload)));
      }
      if (rows.length < 16) break;
      cursor = Number(rows.at(-1)!.cursor);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    for (const entry of this.op.staged.values()) if (entry.collection === this.collection) rank(entry.recordId ?? entry.id, entry.vector, entry.payload);
    // Mem0's fusion only scores semantic candidates; include lexical-only evidence in that pool.
    if (this.collection === 'memories' && this.op.query) for (const row of this.op.lexical(this.op.query, topK)) if (!ranked.some(item => item.id === row.id)) {
      const indexed = this.op.store.get<{ vector: Uint8Array }>('SELECT vector FROM mem0_vectors WHERE record_id=? AND model=? AND dimensions=? AND version=?', row.id, this.op.model, this.op.dimensions, this.op.version);
      ranked.push({ ...row, score: indexed ? similarity(Array.from(new Float32Array(Uint8Array.from(indexed.vector).buffer))) : 0 });
    }
    return ranked;
  }
  async get(id: string): Promise<VectorStoreResult | null> {
    this.op.check();
    const entry = this.op.staged.get(id);
    if (entry) return { id, payload: entry.payload };
    const row = this.op.store.get<{ payload: string }>('SELECT payload FROM mem0_vectors WHERE id=? OR record_id=?', id, id);
    return row ? { id, payload: JSON.parse(row.payload) } : null;
  }
  async update(id: string, vector: number[], payload: Record<string, any>): Promise<void> { await this.insert([vector], [id], [payload]); }
  async delete(): Promise<void> { throw new Error('Erasure must use Pikobot source-backed forgetting'); }
  async deleteCol(): Promise<void> { throw new Error('Reset must use Pikobot source-backed forgetting'); }
  async list(filters?: SearchFilters, topK = 100): Promise<[VectorStoreResult[], number]> {
    this.op.check();
    const rows = this.op.store.all<{ id: string; payload: string }>('SELECT id,payload FROM mem0_vectors WHERE collection=?', this.collection)
      .map(row => ({ id: row.id, payload: JSON.parse(row.payload) })).filter(row => this.matches(row.payload, filters));
    return [rows.slice(0, topK), rows.length];
  }
}
