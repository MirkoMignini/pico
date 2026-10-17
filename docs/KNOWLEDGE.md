# Documents, notes and lists

Pico preserves document originals separately from personal memory. Local conversion uses Firecrawl AnyDoc; QMD supplies rebuildable document retrieval. An uploaded file or retrieved passage is evidence, not an owner assertion or executable instruction.

## Daily use

Ask in chat to save/find a file, read a source, create a note/checklist, or update an item. Trusted retained owner conversations delegate routine document/note/list changes without mandatory confirmation. Current contents must come from canonical revisions and successful receipts, not an earlier assistant claim or memory of a request.

Retained incoming files/images already have durable originals. The agent can annotate them using their actual document IDs rather than re-importing them. Model-authored notes/descriptions retain assistant provenance and consulted-source dependencies; they are not independent factual proof. Restricted/ephemeral writes remain denied.

Receiving a file proves preservation, **not extraction or understanding**. A trusted foreground read can prepare only its already-queued target/revision or join that work; cancelled readers do not start queued processing or abort independent processing. Failed/uncertain inference needs an explicit retry, not an automatic rebill.

## Operator commands

Use your own private instance. A host path typed into chat is not an upload:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE knowledge import /path/to/report.pdf
node dist/cli.js --instance PRIVATE_INSTANCE knowledge list
node dist/cli.js --instance PRIVATE_INSTANCE knowledge read DOCUMENT_ID
node dist/cli.js --instance PRIVATE_INSTANCE knowledge items DOCUMENT_ID
node dist/cli.js --instance PRIVATE_INSTANCE knowledge history DOCUMENT_ID
node dist/cli.js --instance PRIVATE_INSTANCE knowledge original DOCUMENT_ID /new/output-file
node dist/cli.js --instance PRIVATE_INSTANCE knowledge status
node dist/cli.js --instance PRIVATE_INSTANCE knowledge retry DOCUMENT_ID
```

Original downloads verify hashes and refuse overwrite. `knowledge index` updates retrieval; `knowledge rebuild` reconstructs indexes from canonical records, not lost originals. Retry explicitly authorizes another failed processing attempt and can charge for configured image descriptions.

More precise administration uses authenticated `knowledge` RPC:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE rpc knowledge '{"action":"read","id":"DOCUMENT_ID","revision":1,"fromLine":20,"maxLines":12}'
node dist/cli.js --instance PRIVATE_INSTANCE rpc knowledge '{"action":"read","id":"DOCUMENT_ID","fromOffset":40000,"maxChars":2000}'
node dist/cli.js --instance PRIVATE_INSTANCE rpc knowledge '{"action":"edit","id":"DOCUMENT_ID","expectedRevision":1,"find":"exact unique span","replace":"replacement"}'
```

Follow `nextOffset`/`nextLine` until exhausted. Search hits are not exhaustive catalogs, exact counts or proof that a missing item was never saved. Large/long-line reads use UTF-16 offsets; line reads refer to extracted Markdown, not original PDF pages.

For container/remote imports, stream only the selected file through `attachments.upload`, then import its returned ID. Host paths are not container paths; do not expose a broad host mount for convenience. [Deployment](DEPLOYMENT.md).

## Lists and revision-safe edits

The bundled `lists` tool manages canonical editable notes/checklists:

| Action | Contract |
| --- | --- |
| `catalog`, `read` | Paginated notes; exact unique titles or actual IDs. Returns current revision, stable item IDs and counts. |
| `create` | Title and items; Pico assigns the submission identity. |
| `add` | Atomically append the entire batch without replacing existing items or IDs. |
| `update`, `remove` | Actual item ID and matching `expectedRevision`; stale changes fail. |
| `delete` | Authored-list ID and matching revision, using normal source cleanup. |

Items are bounded plain single-line strings; batches and note size are limited. Unknown/action-irrelevant fields and item-ID injection are rejected. Imported originals are not editable list targets. Notes use `notes`; document reads/imports/search use `documents`.

Prose edits require a matching revision and one unique span. To replace an imported original, upload retained replacement bytes and call `knowledge` with `action:"replace"`, the document ID, current `expectedRevision` and `attachmentId`. Old revisions/originals remain available. Annotations belong in separate authored notes; generated representations are not editable originals.

Submission identities make repeated admissions idempotent. Model/service imports may reuse the existing current document for a retained attachment; an import receipt does not silently change its title/description. Supplied ephemeral bytes cannot be promoted by changing a flag. A read or failed write is not a saved mutation.

## Formats and limitations

Content detection takes precedence over filenames. AnyDoc's public Node byte APIs handle supported office formats; small native handlers cover text/JSON/TSV/simple HTML. PDF conversion uses Markdown extraction, not an unavailable structured PDF API. Converter identity/options, hashes, warnings, assets and available locators travel with each revision.

| Format | Capability / limit |
| --- | --- |
| UTF-8 Markdown, text, JSON, TSV, simple HTML | Readable text; TSV is unquoted cells and HTML is not browser rendering. |
| DOCX/DOCM, DOC, ODT | Text and available model structure/assets. Macro-bearing containers do not execute macros. |
| XLSX/XLSM/XLSB/XLS, CSV, ODS | Tables/cached values where exposed; no formula recalculation or universal coordinate mapping. |
| PPTX/PPTM/PPSX/PPSM/PPT, ODP | Text, available notes/assets; no complete visual-layout interpretation. |
| RTF, EPUB | Readable text and available embedded assets. |
| Digital/long/column PDFs | Extracted Markdown; original page/region coordinates and structured PDF models are unavailable. |
| Scanned/mixed scanned PDFs | Original retained with honest `needs_ocr`/limitations; no promised partial OCR. |
| PNG/JPEG/GIF/WebP | Original plus a fallible description/visible-text transcription when the selected model supports vision and is authenticated. |
| Audio | Original; separately enabled transcription can provide a labelled fallible derivative. |
| Video/unknown binaries | Opaque preservation where accepted, not content understanding. |
| Encrypted/malformed/resource-limited files | Explicit outcomes, not guessed or silently empty successful text. |

Hosted AnyDoc OCR is disabled. No Firecrawl credential or hidden OCR/provider fallback is used. Image descriptions are a separate bounded, potentially billable request to the conversation's selected vision model (default model for standalone imports), with pixels/fixed instructions but no tools/chat history. Unavailable vision preserves the original. Successful descriptions are reused; interrupted/failed acceptance is not automatically retried. Ephemeral images create no durable jobs. Scanned PDFs, video frames and embedded images do not gain OCR from this feature.

Tracked changes, comments, footnotes, speaker notes and complex layouts need source inspection. Editorial warnings and bounded original editorial XML are retained where available; ordinary Markdown is not an approval-aware rendering of proposed edits. Cached test fixtures verify specific cases, not universal producer/format completeness. Their [manifest](../tests/fixtures/knowledge/manifest.json) and [public license](../tests/fixtures/knowledge/PUBLIC-LICENSE.txt) stay with them.

## Storage and retrieval

SQLite owns document IDs, revisions, canonical authored text, processing state and provenance. Private `knowledge/objects/ID/REVISION/` stores hashed originals/assets. `knowledge/searchable/` and `knowledge/qmd.sqlite` are derivatives. **Direct editing of projections/snapshot files does not edit a note**; they are reconciled from canonical records.

Originals and durable jobs commit before acknowledgment. Replaced/deleted revisions cannot publish late results. Source reads verify integrity. Local conversion failures have bounded retries/backoff; uncertain image requests require explicit retry. Missing/tampered projections can be rebuilt; missing originals cannot.

Only current authorized projections enter the explicit QMD collection; gold, historical originals and user-wide configuration do not. Keyword retrieval is available before embeddings. Semantic retrieval can download roughly **2.1 GB** of local embedding/reranking/expansion weights and needs several GiB of native RAM. Converter/QMD subprocesses have time, heap and sampled RSS limits, **not OS security isolation**. See diagnostics for lexical/semantic readiness and visible fallbacks.

Foreground startup does not search the historical archive automatically. Current attachments/latest conversational notes can receive bounded previews; the model loads documents on demand. `auto` avoids unnecessary expansion/reranking, while explicit hybrid search can be slower. Missing previews or a source window ending at the last line do not prove complete coverage. Retrieved passages supplied to chat leave the machine for the selected provider.

## Citations

`pico:` citations bind immutable document/revision, representation hash and extracted-Markdown lines (`L`) or UTF-16 offsets (`C`, exclusive end). Resolution verifies that stored span and the original; these are not original PDF coordinates or proof of semantic accuracy.

`completeDocument`/`completeSource` refer to the stored representation/window, not perfect extraction of the original. Follow cursors and read surrounding qualifications before consequential answers. Final citation checks can perform one bounded same-provider read-only repair; persistent invalid citations are withheld. Streamed drafts remain provisional until settlement.

## Retention and erasure

Document originals/assets persist until explicit deletion/forgetting. `mediaDays` expires the intake-media cache, **not durable knowledge copies**. Ephemeral conversion stays volatile and creates no document/job or durable semantic query cache; existing authorized knowledge can be read lexically.

`delete` removes the selected source and linked managed derivatives. `forget` additionally removes byte-identical imported copies and tombstones original hashes against automatic reimport. When a model-initiated deletion would remove dependent owner-visible notes/lists, Pico surfaces them and requires confirmed `cascade:true`; owner/forget paths cascade directly. Independent authored content is not semantically deduplicated away.

Source tombstones and unlink journals precede physical cleanup; stale/deleted records are excluded before index maintenance finishes. Conservative derived-history scrubbing, managed-backup purge and restore guards apply. Backups include canonical records and hashed originals/assets, not credentials/models. External copies and lost deletion ledgers remain separate limits. [Security](SECURITY.md#forgetting-and-restore) · [Recovery](DEPLOYMENT.md#backup-and-restore).

## Development checks

Run the normal check/build/test workflow and the documented [conversion/retrieval checks](TESTING.md#document-conversion-and-retrieval). Fixtures are synthetic or cached public licensed files; Python is development-only for regeneration. Frozen retrieval gold is separate from product/index inputs. Report extraction, supporting-evidence retrieval, supported answers and abstention separately; process exit alone is not a quality score.
