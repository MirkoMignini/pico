# Security, provenance and retention

**Self-hosted is not offline, end-to-end encrypted or sandboxed.** Pico is early-stage software. Application checks reduce risk; they do not prove model factuality, prompt-injection resistance or production security.

## Identity and authority

Each database belongs to immutable owner/instance IDs. Authenticated Unix IPC fixes that identity; request bodies cannot select another owner. The human, assistant and third parties remain distinct regardless of display names. Separate folders under one OS account are not cross-owner isolation.

Documents, mail, forwarded/bot content, transcriptions, tool output and model-extracted facts are **evidence, never permission grants**. Extracted facts keep inferred provenance, original quotes, entities and event/recorded times. Only explicit owner preferences become standing instructions, and even those do not grant capabilities. Memory tags are organizational metadata, not authority.

Routine notes, lists, document management, appointments and reminders are delegated to the model in trusted retained owner foreground work, without mandatory confirmation. Strict schemas, stable IDs, revisions, intention journals and source dependencies still apply. The model can make an incorrect edit or deletion. Google remote writes have a separate, exact single-use terminal approval boundary.

Ephemeral, scheduled, review, untrusted and citation-repair work cannot persist new instructions, code, memory, documents or schedules through canonical services. Allowed read tools do not expand those permissions. Deferred tool loading changes visibility on the next request, not authority, authentication or execution policy.

## Credentials and external services

Credentials belong in the instance's private vault and separate masked/stdin setup flows, not chat, arguments, logs, fixtures or exports. Setup prompts never enter agent history. Credentials are excluded from application backups; protect a separate recovery plan. No environment/`~/.pi`/other-account provider fallback is used.

Authentication and model/account selection are explicit. Login can replace a credential; logout removes its local copy, not provider-side authorization. Normal OAuth refresh may update the selected credential service. A saved key or model listing is not proof of entitlement or successful inference.

Configured providers/connectors receive the data needed for their work and retain it under their own policies. Chat, extraction, embeddings, image descriptions, research, transcription, speech and image generation can incur charges. Subscription authentication is not an API key for auxiliary services. See [setup](SETUP.md).

## Standard skills

[Agent Skills](SKILLS.md) are discovered only in the selected instance's `skills/` and `.agents/skills/`, or explicitly created/imported. Directory drop-ins express operator trust. Instructions and `allowed-tools` metadata never authorize actions. Imported/directory content keeps external provenance; generated content is assistant-authored.

Package publication validates format and immutable hashes without executing scripts or installing dependencies. Reading the enabled current SKILL.md activates instructions across compaction. Invocation pins that revision before journaling, reuses identical argument/revision receipts within the run, and executes a private work copy with scrubbed environment, time/output limits and process-group cleanup. Changed code cannot inherit old test results. Selected host-file imports require the exact path in current owner input or explicit operator RPC; archives reject traversal, links, collisions and expanded-size abuse.

**Scripts still run with OS-user permissions.** They can read accessible files/vaults, use the network, spawn escaping descendants and leave irreversible effects. Temporary HOME and process limits are not a hard OS resource or security boundary. Exit zero proves return, not correctness or accepted delivery. Failed/uncertain effects are not automatically replayed.

## Trusted in-process extensions

Extensions run **inside the daemon**, with its full OS permissions. Their imports/factories can access credentials, alter files, incur charges, crash Pico or block the event loop and reminder delivery. There is no per-extension sandbox, Docker worker, watchdog or hard resource limit. Do not share a daemon/OS account between mutually untrusted code or owners; separate constrained containers/VMs are optional whole-owner boundaries.

New generated modules are syntax-checked and immediately activated without confirmation in trusted retained foreground work. This delegates executable trust to the model. Syntax validation is not import resolution, behavioral testing or a security audit. Failed/cancelled/interrupted initialization is held disabled rather than automatically repaired/replayed; enabled successful modules initialize on later startups.

Validation-only artifacts require exact-hash, expiring, single-use authenticated terminal approval. Existing pending or retired-worker approvals are not silently converted into native permission. Local `extensions/` files are a deliberate trust decision.

Canonical services preserve identity, schemas, modes, budgets, provenance and journals; API scopes expire after execution. Third-party tool dispatch is denied in restricted modes. **Native code can bypass those APIs through ordinary Node access**, including during initialization/timers. Disable/rollback requests cleanup and stops future dispatch; it cannot undo effects, forcibly unload imports, stop hostile code or erase independent host state. Restart is needed to discard Node's loaded-module cache. [SDK](SDK.md).

## Integrations and untrusted content

- **Telegram:** authorize the actual private numeric sender before storage/download. Every allowlisted ID has owner authority. Forwarded/bot content remains evidence; replies and tool sends use the authenticated recipient, not a name or forwarded origin. Size/signature/redirect checks precede retention. Drafts/reactions acknowledge activity or intake, not completion; accepted Bot API IDs are not human read receipts. [Channel contract](CHANNELS.md).
- **Google:** services/scopes are opt-in; writes start disabled and need additional consent plus exact, expiring, single-use owner-terminal approval. Payload/account/settings/source/revision checks and attempted-action tombstones precede remote effects. Mail/docs/events cannot approve themselves. Sheets uses preflight comparison, **not atomic compare-and-set** against concurrent editors; keep writes off if that limitation is unacceptable. [Google](GOOGLE.md).
- **Family:** bilateral owner-terminal public-key authorization grants only consented one-shot reminders and explicitly shared current checklist items. Signed `/family` requests never authorize owner RPC, memory, chat, files or historical revisions; recipient configuration fixes reminder delivery. Normal restarts retain grants; restore deactivates peers, clears shares and cancels restored family work. Remote copies cannot be recalled. Same-host Unix transport is not OS isolation or Internet federation. [Family contract](FAMILY.md).
- **MCP:** operator-selected trusted servers, not a sandbox. Stdio has OS-user access; HTTP checks/pins all DNS answers, requires HTTPS/public addresses unless the owner explicitly opts a selected origin into private networking, and refuses redirects. Credentials are vault-bound to the endpoint/command/account; OAuth retains issuer/resource binding. Tool hints, roots, prompt messages and server requests never grant authority. Unknown effects require exact single-use terminal approval; only exact owner-declared reads bypass it. Optional elicitation/sampling needs another fresh terminal response, with no private-context/tool sharing. Restricted modes cannot dispatch MCP. Connection notifications do not automatically read, infer or persist content; accepted remote jobs/copies remain outside local cancellation/erasure. [MCP](MCP.md).
- **Web:** public HTTP(S)/standard ports only; validate all DNS answers and redirects, pin connections, bound responses and refuse ambient credentials/cookies/authenticated redirects. No page JavaScript or subresource browsing. Search snippets are not fetched pages. Captures are evidence, not automatic personal memory. [Features](FEATURES.md#web-search-and-research).
- **Research:** a bounded same-model Pi child receives only necessary context and read-only bundled web/time tools, without personal-memory access, shell, writes, delivery or recursive delegation. Its synthesis remains fallible.
- **Media:** local conversion preserves unsupported originals with explicit limitations; no hosted PDF OCR is silently enabled. Image descriptions/transcripts are model-authored, source-linked and fallible. Queued target reads can join processing, but failed/uncertain inference needs explicit retry. Cancellation/erasure prevents late publication, not accepted provider charges. [Documents](KNOWLEDGE.md).

## Retention

| Data | Managed boundary |
| --- | --- |
| Saved conversations, memory, notes and appointments | Private SQLite/source records until deletion or forgetting. |
| Document originals/assets | Durable copies until explicit deletion/forgetting; media-cache expiry does not remove them. |
| Raw media and generated images | Private files follow `mediaDays`; linked metadata/derivatives may outlive raw bytes. |
| Skills, managed extension artifacts and state | Owner-scoped versioned records; source-linked erasure and backup/restore apply. Manually installed native files and independent state need separate handling. |
| Web receipts | Bounded private captures until forgetting; explicit saving enters durable knowledge. |
| Credentials | Separate private vault, excluded from application backups/exports; includes the family signing key. |
| Family identities/grants/protocol metadata | Private SQLite; no message/list bodies in protocol receipts. Explicit revocation stops new access and unsent incoming family reminders; shared data already retained by another owner is outside local erasure. |
| Ephemeral chats | Volatile content; no durable content writes or execution. Restart loses them. |
| Indexes and weights | Rebuildable derivatives/caches, not canonical evidence. |
| Provider/Telegram/downloaded copies, OS snapshots, external backups | Outside Pico's erasure guarantees. |

`/new` starts a **saved** conversation, not incognito. API/legacy ephemeral safeguards remain; existing authorized data may be read without durable query/activation lineage. Ephemeral conversion and browsing stay volatile, with lexical-only knowledge queries to avoid durable semantic caches. Independently configured synchronization has separate retention. No cryptographic RAM, swap or forensic disk erasure is promised.

Secrets voluntarily pasted into ordinary chat become retained content. Exact instruction snapshots, visible reasoning, source reads and tool receipts can contain private data; they are not safe public logs. Redacted/provider-hidden reasoning is not exposed. Display metadata does not become owner evidence or extra agent context.

## Forgetting and restore

Forgetting removes linked source versions, derivatives, indexed data, dependent code/state/schedules/appointments and conservative assistant/tool history. It may erase more dependent context than the selected fact alone; independently authored statements are not semantically deduplicated. Model-initiated document deletion surfaces dependent owner-visible notes/lists and requires a confirmed cascade. Ordinary record deletion and full source forgetting have different scopes.

Deletion state/tombstones commit before physical unlink. Cleanup journals recover interruption; indexes and old-backup restore cannot silently resurrect known erased sources. Managed backups are purged. Independently copied files, native module state, downloaded outputs and external backups remain separate boundaries.

Restore verifies owner/instance, SQLite, content hashes and references, applies available deletion history and reconstructs canonical packages. Post-snapshot skill directories are held in private recovery storage, not silently enabled. Snapshot-pending work may have taken effect later: pending deliveries become uncertain, unfinished work interrupted and overdue schedules paused for review. If both the current DB and latest deletion ledger are lost, an older backup may still contain forgotten data. [Recovery procedure](DEPLOYMENT.md#backup-and-restore).

## Local diagnostics and maintenance

`doctor` is an allowlisted, non-starting diagnostic: it omits owner identity, private content/paths, vault values and raw provider/module errors. Offline inspection never opens/migrates SQLite, loads instance code or probes services; online inspection contacts only an already running authenticated Unix `health` endpoint. Detailed `status`, native service logs and arbitrary trusted extensions remain private and outside that redaction guarantee. Readiness distinguishes stored credentials from observed authentication/reachability and exact explicit model-test results; no automatic billed test or credential refresh is performed. See [installation/operations](INSTALLATION.md).

Per-user service installation is explicit and never initializes an owner or restarts it. Managed stop/restart uses authenticated idle-only IPC and refuses open TUI/event streams rather than discarding drafts/dialogs. Ephemeral loss needs acknowledgment. Native manager commands and OS shutdown bypass these application guards; a status snapshot is not a maintenance lock. Service registration is host-local, not a portable credential/backup or new authority boundary. Version selection never downgrades data or replays uncertain effects.

## Cancellation and receipts

Intention journals precede effects; stable input IDs reject changed-body replay. Lost acknowledgment is **uncertain**, not success or permission to resend. Cancellation includes preparation/retrieval and can stop later model work, but cannot undo accepted writes, sends or charges. Multipart partial acceptance remains uncertain. Explicit retries can duplicate effects.

Builds receive one additional configured timeout window, capped at twice the ordinary run timeout, not renewable by repeated builds. A completed activation followed by timeout is not rolled back or automatically rebuilt. Supervised native workers may be terminated for cancellation; that containment does not sandbox trusted code.

Use completed canonical receipts and current state, not an assistant's claim. `receipts_list`/source reads preserve ownership and upstream erasure; private service journals and erased results are excluded. Incomplete previews/cursors must be followed before claiming exhaustive coverage. A valid citation identifies a stored span, not semantic truth.

## Dependency checks

`pnpm audit --prod` currently reports a high-severity [stack-exhaustion advisory in transitive `braces@3.0.3`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), through QMD → fast-glob → micromatch. The advisory names 3.0.4 as fixed, but that version is not published in the registry. Pico's QMD collection uses a fixed `*.md` glob, not caller-supplied patterns, and runs in a bounded subprocess. This limits the identified exposure; it does **not** make the audit clean. Recheck before release, upgrade when an upstream fix is available and do not expose arbitrary glob/config inputs meanwhile.

CI uses `pnpm audit --prod --audit-level high --ignore GHSA-vfj7-8cjw-p6xm` to gate other high/critical advisories without suppressing unrelated failures. This is a single explicit temporary exception, **not** a clean raw audit. Remove the exception as soon as an upstream fix is published and verified; Dependabot updates and the public dependency-tracking issue support that follow-up. Run the unfiltered command above when reviewing a release. pnpm's `--ignore` option persists its exception in the runner's disposable `pnpm-workspace.yaml`; do not commit that generated change or add it to your ordinary local audit configuration.

## Reporting a security issue

Use [GitHub private vulnerability reporting](https://github.com/MirkoMignini/pico/security/advisories/new), as described in the [security policy](../SECURITY.md). Do not post credentials, private transcripts, exploit payloads against real owners or unredacted diagnostic logs in public issues. Include a minimal synthetic reproduction, affected revision and expected/actual boundary. No independent security certification or guaranteed response SLA is claimed.
