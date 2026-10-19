# Source-backed memory

Pikobot uses [Mem0 OSS](https://github.com/mem0ai/mem0) through instance-local model, embedding and SQLite adapters. No hosted Mem0 account or separate vector server is required. Conversations run through Pi agent-core; memory remains source-backed evidence, not an independent authority system.

## What is stored

Background extraction validates facts, verbatim quotes, entities, dates and contextual dependencies, then stores them automatically. There is no memory-confirmation queue. Ask naturally what Pikobot remembers, correct a statement, or ask it to forget a source.

| Record | Meaning |
| --- | --- |
| Automatically extracted fact | `basis: inferred`, `status: stored`; searchable but not verified truth or an instruction. |
| Explicit canonical assertion | `status: current`, with its actual owner/document source. |
| Superseded/history record | Retained lineage for corrections and historical questions, not necessarily current truth. |

The human owner, assistant and third parties remain distinct. An assistant question can contextualize an owner's quoted reply; assistant guesses cannot establish owner facts. Only explicit owner preferences become standing instructions, never permissions. Quoted document claims can be deliberately stored with document/revision provenance; document text does not become an owner instruction.

Original statements remain searchable even when extraction misses a detail. Check consequential or conflicting claims against the source. Storage and a matching quote prove provenance, not semantic correctness.

## Recall and context

Historical memory/document searches happen on demand. Beyond current dialogue, bounded owner basics, explicit preferences and current attachments, the agent should call `memory_search`, narrow entity/time filters when needed, then read evidence with `memory_read` or `source_read`. Missing startup context does not prove a fact was never supplied.

Source reads can expose bounded related-document references; they are not exhaustive catalogs or the documents' complete contents. Load document tools for canonical reads/search. Installed skills use a metadata catalog and progressive instruction/resource reads, not automatic procedure dumps.

Finite context/tool budgets and model-selected searches can miss evidence or add round-trips. A citation or retrieval hit does not establish that every claim in an answer is supported. Ordinary replies need not print internal IDs; source inspection remains available on request.

## Owner basics at chat startup

Authenticated owner foreground/ephemeral chats receive a bounded, query-independent basics block: applicable `preferred_name`, `name`, `home_city`, `home_country`, `occupation` evidence. Opening a conversation makes no inference request.

- Only retained owner-authored sources qualify. Inferred values require their verbatim quote; external/assistant and document-confirmation sources are excluded.
- Scope, expiry, source time and explicit-current assertions determine eligibility. Ambiguous alternatives remain labelled, not promoted to verified biography.
- Values/quotes/context are bounded; the total block is at most 2,000 escaped characters and may shrink under context pressure. Unsupported dependencies are omitted.
- Selection makes no model/embedding calls or profile writes. Retained runs link injected evidence for erasure; ephemeral reads create no durable lineage. Restricted background work gets no basics block.

This is fallible evidence, not a permission grant or guaranteed attribution classifier. Forgetting a widely used basic fact can conservatively scrub more dependent replies/instruction snapshots.

## Tags and operator inspection

Extraction may suggest a few concise topic tags in its existing call. Tags are optional, lowercase ASCII words/dashes, at most 48 characters and eight per fact. They do not change a fact's basis, source or authority.

The agent's `memory_search` and operator `memory.search` support tags, kind, basis, entity, scope and time/history filters. Multiple tags must match **the same fact**. Eligibility is enforced in SQLite before ranking and rechecked after asynchronous reads; stale vector payloads cannot grant access. Wrong/incomplete tags can miss evidence, so broaden searches when needed.

Authenticated operator RPC examples:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE rpc memory.list '{"tags":["food"]}'
node dist/cli.js --instance PRIVATE_INSTANCE rpc memory.search '{"query":"dinner","tags":["food"]}'
node dist/cli.js --instance PRIVATE_INSTANCE rpc memory.read '{"id":"MEMORY_ID"}'
node dist/cli.js --instance PRIVATE_INSTANCE rpc memory.tag '{"id":"MEMORY_ID","tags":["food","health"]}'
```

`memory.tags` lists bounded topic counts. `memory.remember` creates an explicit canonical assertion; `memory.retry` explicitly requeues failed extraction and may charge. These are administration APIs, not everyday slash commands. Relabelling never changes quotes, timestamps, provenance or embeddings.

## Embeddings and implementation

New instances default to DeepSeek Flash chat/extraction and OpenAI `text-embedding-3-small` embeddings; both can incur charges. Existing settings are preserved. Local E5 or disabled embeddings are explicit alternatives. Missing/failed hosted embeddings degrade visibly to lexical retrieval, not another provider/account. [Setup](SETUP.md#memory-embeddings).

`src/mem0.ts` connects Mem0 to Pikobot's authoritative store and credential services; `src/memory.ts` validates evidence, namespaces, context and erasure. The pinned dependency patch disables Mem0 telemetry, independent history/default home files and unsafe JSON cleanup for Pikobot's adapter. Dependency upgrades need patch review and regression checks.

Validated source records and Mem0 derivatives commit together after source/cancellation checks. SDK additive extraction cannot silently overwrite explicit assertions. Existing retained records and legacy confirmation lineage survive migrations; no new confirmations are manufactured. Mem0's separate history store is disabled.

Retrieval combines SQLite FTS with a streaming cosine-vector scan, yielding for cancellation. It is **O(n), not approximate-nearest-neighbor indexing**. Entity/deduplication candidate pools have finite bounds. Large-archive latency, composite/duplicate facts, imperfect keys and omissions remain limitations. The compatibility `maxScan` setting does not silently truncate the archive.

## Forgetting and recovery

Source-aware forgetting removes linked facts, quotes/context dependencies, raw media, vectors, tags and dependent managed code/state/schedules/history. It preserves tombstones against re-extraction and old-backup resurrection. Independent statements are not erased merely because their wording is similar.

SQLite is authoritative; indexes are rebuildable. Backups include memory and lineage in the same snapshot, exclude credentials and repeat erasure checks during restore. Keep the latest deletion ledger and protect/purge external copies. [Security](SECURITY.md#forgetting-and-restore) · [Recovery](DEPLOYMENT.md#backup-and-restore).

Ephemeral inputs never enter durable extraction. Existing authorized memories may be read, without SDK histories/query caches/entity writes. Providers and OS retention remain separate; volatile does not mean cryptographic erasure.

## Verification

`pnpm test` covers extraction/storage boundaries with synthetic providers, actual SQLite, migrations, cancellation, forgetting and restore. `pnpm test:memory:stress` uses synthetic dense vectors, not semantic-quality scores. Authorized live memory evaluation is separate and can charge for chat/extraction/embeddings. Follow [testing](TESTING.md) and the [evaluation rules](../eval/GRADING.md); report recall, extraction, attribution, answer accuracy and abstention separately.
