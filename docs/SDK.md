# Extension SDK and workflows

Prefer standard [Agent Skills](SKILLS.md) for utilities, calculators, scripts/assets and reusable procedures. Use extensions for persistent integrations, channels, RPC and daemon lifecycle hooks.

Extensions are **trusted TypeScript/JavaScript inside the daemon**, with full OS-user access. There is no extension sandbox, worker broker or full Pi coding-agent/UI compatibility. Application API checks cannot confine direct Node code. Read [security](SECURITY.md#trusted-in-process-extensions) before loading one.

## Bundled modules

`src/features/` contains registering factories, enabled by default and independently controllable:

| Module | Tools / responsibility |
| --- | --- |
| `notes-lists`, `documents` | Canonical notes, lists, imports, search and source reads. |
| `google` | Optional Gmail/Docs/Calendar/Contacts/Drive/Sheets/Tasks and exact remote-write approvals. |
| `telegram` | Authorized private transport, files, progress and optional voice replies. |
| `skills`, `workflows` | Standard packages, script execution, procedural learning and bounded tool composition. |
| `planning`, `reminders` | Local calendar/agenda and durable schedule creation. |
| `web`, `research` | Guarded public fetching and bounded read-only delegation. |
| `images` | Existing-image presentation and explicitly enabled generation. |
| `family` | Narrow same-host owner links, consented one-shot reminders and explicitly shared checklist items; membership setup stays in owner-terminal RPC. |
| `extension-developer` | Syntax checking and immediate activation of generated modules. |

Core keeps authenticated canonical services, SQLite, ownership/mode policy, revisions, provenance/erasure, journals/budgets, models/context and model-independent delivery.

```text
/extensions disable google
/extensions enable google
```

Disabling removes dispatch/instructions and requests cleanup; it does not delete saved records, undo effects or forcibly unload Node imports.

## Local modules and tool registration

Place trusted `.ts`, `.js` or `.mjs` files in `PRIVATE_INSTANCE/extensions/`, or `extensions/NAME/index.ts|js|mjs`. IDs are lowercase dashed names, 3–48 characters. Only this instance loads; no `~/.pi`, ambient project discovery or automatic dependency installation. Node 24 supports erasable TypeScript, not JSX/enums or Pi virtual aliases. Ordinary imports use Node resolution.

[The word-count module](../examples/word-count.ts) illustrates the registration API, not the recommended packaging for a standalone counter (use the [skill example](../examples/skills/text-statistics/SKILL.md)):

```ts
export default function (pikobot) {
  pikobot.registerTool({
    name: 'word_count', label: 'Word count', description: 'Count supplied words.',
    parameters: pikobot.Type.Object({ text: pikobot.Type.String() }, { additionalProperties: false }),
    async execute(callId, { text }, signal, onUpdate, context) {
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      return { content: [{ type: 'text', text: String(words) }], details: { words } };
    }
  });
}
```

Authoritative types are [extensions.ts](../src/extensions.ts) and [extension-services.ts](../src/extension-services.ts). Names register directly with Pi agent-core; core/duplicate names are rejected. Parameters need strict **object-root** TypeBox schemas. Results have validated text/image `content` and JSON `details`.

## Execution context and services

`context` is frozen owner/instance/conversation/run/source/mode metadata. Identity is fixed by authenticated execution, not tool arguments. `writesAllowed` is false for ephemeral, scheduled, review, untrusted and citation-repair work; honor it for operations outside canonical services too. Service callbacks expire after execution and reject disabled/shutdown scopes.

| API | Contract |
| --- | --- |
| `context.services.documents(request)` | Strict document/note/list actions, original integrity, matching revisions/unique spans, processing joins, source lineage and erasure. [Documents](KNOWLEDGE.md). |
| `calendar(request)` | Local appointment CRUD/list/agenda; revision-safe writes/conflicts. [Planning](FEATURES.md#agenda-and-reminders). |
| `family(request)` | Trusted retained foreground per-member/list capabilities; `create` atomically creates a local shared checklist. `create`/`share` default to read/write, explicit `read` stays read-only. No membership authorization, owner identity override or private remote data. [Family](FAMILY.md). |
| `web(request)` | Configured-provider search/fetch/read/save with guarded networking and external attribution. [Web](FEATURES.md#web-search-and-research). |
| `research({task,context?})` | One bounded same-model read-only child with necessary supplied context, bundled web/time tools and shared budgets. |
| `showImage({attachmentId? \| documentId?,revision?})` | Present exactly one retained image in the matching conversation; no URL/host path or generation. |
| `generateImage({prompt,size?})` | Explicitly enabled metered generation, one attempt per run, private output and separate delivery receipts. [Images](FEATURES.md#image-generation). |
| `readSkill({name,path?,fromOffset?,maxChars?})`, `skills(request)`, `runSkill(request)` | Versioned package reads/management and revision-pinned journaled scripts. Legacy procedural `readSkill(id,version)` remains. [Skills](SKILLS.md). |
| `createSchedule(definition)` | Trusted retained foreground creation with validation, source dependencies and a saved receipt. No mandatory reminder approval. |
| `complete({systemPrompt?,messages,maxTokens?})` | Bounded completion through the conversation's selected model/account (default for standalone operator work), never a provider/credential override. Can charge. |
| `builds.begin(specification)`, `update(buildId,status,diagnostic)`, `stage(buildId,module)` | Current-run build lineage, syntax validation and immediate activation; inspect `activated`, `tools`, `error`. |
| `context.callTool(name,args)` | Invoke a registered core/feature tool with its schemas, authority and shared budgets. |

Await writes before claiming success. Model-facing/native/nested-service calls share configured tool/model limits, cancellation and distinct intention/receipt IDs. Interrupted or uncertain effects are not automatically replayed; completed receipts are reusable only for matching calls. Reading a result wrapper is not necessarily reading its entire underlying source.

Document imports can reuse an existing current document for a retained attachment; model/service `submission` is optional. Notes/lists get server-assigned creation identities. Reads can join only the requested queued processing; restricted modes cannot start conversion/inference and uncertain failed inference requires explicit retry.

## Integration setup, storage and channels

These interfaces are generic; provider-specific clients belong in extensions, not core:

- `pikobot.replaceTools(tools)`: atomically replace this module's tools, preserving the previous set on validation/name collisions. It does not activate another module or expand authority. `trustedOnly: true` on a bundled tool retains the trusted-foreground dispatch restriction (used by MCP); it cannot make third-party modules more privileged.
- `pikobot.registerSetup({title,description,parameters,read,save,secrets,prepareSecret?})`: one strict non-secret settings object and separately masked `{name,label}` fields. Generic RPCs are `extensions.setup({id})`, `extensions.configure({id,settings})`, `extensions.secret({id,name,value})`; TUI `/integrations setup ID` handles separate dialogs. Partial persistence is reported, not rolled back silently. Optional synchronous `prepareSecret(name,value)` validates/transforms masked input before private vault storage; MCP uses it to bind credentials to the selected endpoint/command/account. Never return secret material from `read()`.
- `pikobot.credentials`: owner-vault `read`, serialized `modify`, `delete` and supported `secret` reads. Registered extension secrets use `extensions.MODULE_ID.NAME`. Never expose credentials in tool inputs/results, chat, ordinary settings or logs.
- `pikobot.storage.get<T>(key)`, `list(prefix)`, `set(key,value,sourceIds?)`, `delete(key)`: owner/module-namespaced SQLite. Keys ≤200 characters, JSON ≤1,000,000 characters and ≤1000 supplied dependencies. Forgotten dependencies fail atomically; erasure/restore purge linked state. Supply actual dependencies and honor `writesAllowed`. This is not credential storage or confinement of direct Node access.
- `pikobot.on('agenda', async (range,context,signal) => ({items,truncated,warnings}))`: bounded selected remote contributions to canonical agenda, not local copies or permission. Items carry IDs, titles, explicit instants/all-day metadata and provenance. Failed providers make the agenda incomplete. `pikobot.agenda(range,context,signal)` collects contributions.
- `await pikobot.registerChannel(adapter)`: validated module-owned registration/lifecycle. Authorize senders **before storage/download**, capture `pikobot.inputEpoch` before asynchronous preparation, then call `pikobot.ingest(channel,input,sender,mode,epoch)`. Only registered channels are admitted, with fixed owner/instance and recipient namespaces. [Adapter contract](CHANNELS.md).
- `pikobot.registerRpc({name,parameters,execute})`: authenticated owner-terminal routes under `extensions.MODULE_ID.METHOD`, not a model-facing dispatcher.
- `pikobot.setStatus(key,text?)`: a bounded literal terminal footer entry; omit text to clear it. Display-only, never evidence or authority.

Integration TUI conventions are `extensions.ID.auth`, `.auth.cancel`, `.status`, `.disconnect`, `.actions.list`, `.actions.review({id})`, `.actions.approve({id,digest,decision})`. A provider implements them; core never infers authority from names. Google and MCP reuse expiring payload/connection-bound approvals and attempted-action tombstones. [Google](GOOGLE.md) · [MCP](MCP.md).

## Lifecycle hooks

| Hook | Responsibility |
| --- | --- |
| `instructions` | Cross-tool guidance for visible tools/current channel; do not duplicate tool descriptions. |
| `start`, `shutdown` | Setup and cooperative cleanup. |
| `background` | Admitted work with `{signal,modelWorkAllowed,phase}`; honor cancellation and model-work admission. |
| `settled` | Successful trusted retained foreground work. |
| `busy` | Pending sign-in/work that must block reload. |

Instruction-only/current-channel guidance can appear at startup; other guidance follows visible tools. Cached tokens still occupy context. Settings application reloads factories, but helper imports may remain cached; a full backend restart resets the process cache. Cleanup cannot undo effects or terminate hostile code.

## Discovery, receipts and context

Main chats start with eight recall/discovery/reminder definitions. Other registered/enabled tools appear in a schema-free grouped catalog, 32 names per page. `tools_load({names:[...]})` exposes at most eight exact names on the **next request**, not the same batch; omitting names with optional `offset` reads another catalog page. Loading imports/enables/authenticates nothing. Unknown/disabled/mode-forbidden names fail atomically. Actual historical calls can restore definitions for provider replay without rerunning effects.

Newly activated tools appear automatically on their originating run's next request. Selections are run-scoped and volatile. CLI/RPC/workflows use the registered services with their existing checks; child research/citation repair cannot escape allowlists via discovery.

Model-facing output is bounded to 24,000 serialized characters with incomplete-preview/recovery metadata. Full validated originals stay private. `source_read` supplies paginated UTF-16 windows (maximum 10,000 characters), source coverage and bounded related-document references. `receipts_list` gives trusted owner foreground/ephemeral access to paginated historical metadata, excluding current/discovery reads, private `$` service journals and erased results. Exact argument filters are not proof of absence; key ordering can matter. Read actual receipts before interpreting external acceptance/current state.

Known bundled read results can become 2,000-character historical references; writes/delivery, errors, unfinished/failed runs, diagnostics and unknown implementations are preserved. Optional tool `history` metadata is `read`, `effect` or an action map; it is a bundled compaction optimization, not authority inherited by arbitrary names. Coverage/cursors still apply after recovering a wrapper. Current reminder snapshots supersede old creation receipts; only accepted delivery receipts establish transport acceptance, never human reading.

## Generated modules and manual review

`extension_build`/`extensions.build` uses bounded selected-model generation to produce `{sdk:2,id,version,description,source}`, syntax-checks it and **activates immediately without confirmation** in trusted retained foreground work. Generated single-file modules use Node builtins/supplied API, not arbitrary relative/package imports. [Artifact example](../examples/word-count.json).

Inspect the receipt: `report.executed:false`/`testsRun:false` describe inert syntax checks; `activated:true` means imports/factory actually ran with full daemon/OS trust. The compact model receipt omits duplicate source/specification; immutable artifacts and private owner receipts retain them. Initialization failure/interruption disables the install rather than automatically repairing/replaying accepted code. Successful enabled modules survive restart.

The first canonical build/skill preparation grants one extra `limits.runTimeoutMs` window, capped at twice the ordinary run timeout. It is not a sliding deadline; repeated builds do not renew it. A completed build followed by timeout stays completed, with follow-up work marked incomplete. Owner RPC has a separate bounded timeout.

Validation-only artifacts remain inert until exact-hash, expiring, single-use terminal approval:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE extensions validate examples/word-count.json
node dist/cli.js --instance PRIVATE_INSTANCE rpc extensions.review '{"id":"APPROVAL_ID"}'
node dist/cli.js --instance PRIVATE_INSTANCE rpc extensions.approve '{"id":"APPROVAL_ID","hash":"EXACT_HASH","decision":true}'
```

Manual activation/disable/rollback refuses active work. Neither approval nor syntax checking establishes behavioral/security correctness. Retired worker artifacts/approvals remain inert data, never native execution authority. Managed artifacts participate in source forgetting/restore; independently installed native files and external state do not.

## Workflows and learning

[Workflow examples](../examples/booking-lookup-workflow.json) compose one to eight currently registered, schema-validated steps. Execution rechecks tools, authenticated mode and budgets. Recursion, code generation and executable-package management are forbidden. A workflow expands no authority and cannot undo earlier accepted steps. Version/enable/rollback controls remain owner operations.

Bounded procedural review can propose instruction candidates after successful work. Candidate activation requires exact instruction-hash owner review; explicit owner-authored `skills.learn` is separate. These legacy scoped procedures coexist with standard file packages; neither grants permission. Core memory extraction is inferred evidence, compaction derived context and reminders remain independent of optional modules/models.
