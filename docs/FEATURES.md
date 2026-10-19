# Planning, web research and images

Use ordinary chat for these features; slash commands are reserved for conversation controls, setup and administration. Bundled modules can be disabled without deleting their saved records. [Setup](SETUP.md) · [Security](SECURITY.md).

## Agenda and reminders

Ask for an appointment with a start/end, move it while preserving other fields, inspect overlaps, or ask what's on your agenda. Local `calendar` records have stable IDs/revisions, optional location/notes and conflict warnings; overlapping events are not overwritten. `agenda` combines local appointments, active reminders/tasks and selected calendars contributed by enabled integrations. External failures mark results incomplete rather than inventing availability.

**Appointments do not automatically create alerts.** Ask for a separate reminder. Moving/deleting an appointment does not silently change its independent reminder. Source forgetting can remove linked derived records.

Routine local writes are delegated in trusted retained owner foreground work, without mandatory approval. Strict schemas, revisions, journals and restricted-mode denials remain. Clarify genuinely ambiguous targets/times, not routine permission.

- Calendar start/end are explicit-offset ISO instants with a later end; timezone controls display. Updates/deletion require actual IDs and the current `expectedRevision`.
- Agenda defaults to the configured IANA timezone and paginates. `week` is seven local calendar days, not always 168 hours. Today includes overdue active reminders. Projection does not dispatch or change schedules; bounded/truncated counts are explicit.
- The `time` tool resolves local today/tomorrow and optional clock values. Nonexistent/ambiguous DST local times fail; provide an explicit offset. Elapsed-minute arithmetic is not calendar-day arithmetic.
- Local appointments do not provide recurring/all-day events, invitations, external sync or availability sharing. Google occurrences/all-day reads belong to the separate [integration](GOOGLE.md), not automatic local copies.

Advanced owner RPCs are `calendar` and `agenda`; extensions use `context.services.calendar(request)`. Current action schemas/bounds live in [calendar.ts](../src/calendar.ts).

Reminders are durable schedule/occurrence/outbox records. Deterministic reminder text needs no model at delivery time; scheduled agents are bounded read-only work. Creation/updates/cancellation are delegated in trusted retained chats. Updates replace complete definitions and cancel superseded unsent work. Pausing/cancelling cannot undo accepted sends.

Quiet hours use the owner timezone; proactive daily caps use UTC days. Misfire policy controls ordinary restart catch-up. Outbox `sent` means accepted transport delivery, not human receipt; uncertain acceptance is never automatically resent. Offline restore deliberately holds potentially already-executed pending work for review. [Operation and recovery](DEPLOYMENT.md#delivery-and-restarts).

## Web search and research

DuckDuckGo is the default, keyless HTML adapter—not an official stable search API. Challenges, throttling or changed markup can fail. Brave is optional and can charge; select it through `/setup` → Web search with masked `brave.searchKey`. No automatic account/provider fallback or challenge bypass occurs. `search:null` restores DuckDuckGo; disable `web`/`research` to remove model dispatch.

| Tool | Behavior |
| --- | --- |
| `web_search` | Structured results/snippets and a captured search receipt; result pages are not automatically fetched. |
| `web_fetch` | Fetch one public HTML/text/Markdown page, extract readable text and capture bounded original bytes, URL/time/hashes/warnings. |
| `web_read` | Read captured sections with pagination, without another network/model call. |
| `web_save` | Preserve a useful capture as externally attributed durable knowledge in trusted retained foreground work; no blanket automatic archive. |
| `research` | One focused same-model/account read-only Pi child per parent run, with necessary supplied context and verified source citations. |

Pasted URLs are not opened at intake. The model may read a relevant owner-supplied URL; it must not claim to have read a page without a successful receipt. Prefer direct tools for simple lookups. Search snippets, fetched pages and researcher synthesis are distinct evidence types, never permission grants.

Network controls validate public HTTP(S), standard ports, URL credentials, all DNS answers and every redirect; connections are pinned with Host/SNI/TLS checks. No cookies, ambient authentication, caller headers, page JavaScript or subresource downloads. Authenticated redirects are refused. Responses are limited to 2 MB wire/decompressed data, five redirects and 15 seconds; parsing is separately bounded in a subprocess, not sandboxed.

Captures/read previews can be incomplete; follow cursors. `pikobot:web:` citations identify stored text ranges, not factual correctness. Retained captures live privately until forgetting; ephemeral captures are conversation-scoped memory-only data and cannot be promoted. No automatic personal-memory/QMD ingestion occurs. Same-URL/content tombstones and erasure guards prevent late reintroduction of forgotten captures. Operator `web.list`, `source.read`, `web.forget` provide administration.

Research has only bundled web reads and time—no automatic personal-memory access, writes, delivery, shell or recursive delegation. It shares parent cancellation/budgets, with at most four model requests, eight tool calls and 60 seconds. Logical limits and estimated prices are not invoice caps. Queries/URLs leave the machine; accepted provider requests may charge even after cancellation.

The extraction/Brave adaptation reuses MIT [Pi Brave Search material](https://github.com/badlogic/pi-skills/tree/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search), with its [license notice](https://github.com/MirkoMignini/pikobot/blob/main/docs/licenses/pi-skills.txt) retained.

## Optional interactive browser

For JavaScript-driven or authenticated sites, use the opt-in [browser MCP prototype](BROWSER.md), not `web_fetch`. A separately installed trusted Playwright server uses a dedicated profile, or an explicitly paired extension/desktop bridge controls personal Chrome on another computer over a private SSH tunnel. Its exact tool allowlist runs autonomously from trusted owner chat, including Telegram, without per-action approval. Effects stay journaled as effects and failed/uncertain calls are not replayed. Human login/CAPTCHA handoff, bounded file-backed snapshot reads and source-linked screenshot/download imports reuse MCP and normal attachments. This is not a native browser subsystem, seamless automation or an execution sandbox.

## Existing image replies

Ask Pikobot to show a saved image in the current conversation. `image_show` accepts a retained attachment or image-document ID and optional immutable revision; it needs neither Telegram nor image-generation credentials. Host paths, URLs, volatile/unknown/tampered originals and non-images are refused.

The TUI displays a preview in the matching selected conversation when its terminal supports graphics, otherwise a labelled placeholder. PNG/JPEG/GIF/WebP are supported; non-PNG previews are normalized locally without rewriting originals. Animated originals show a still preview. Normalization has pixel/size/time/process bounds, not an OS sandbox.

Telegram image sends also publish a same-conversation preview, **not proof of remote acceptance**. History/reconnect recovers a few saved references without resending/regenerating; preview bytes have a finite cache budget. Owner RPC `images.preview` verifies and returns display-ready PNG bytes, while `images.previews` lists recent references. Preview metadata does not automatically supply pixels to the model.

## Image generation

Generation is disabled until explicitly configured. Use `/settings imageGeneration`, for example `{"provider":"openai","model":"gpt-image-1","quality":"low"}`, and apply. A masked `openai.imageKey` overrides the stored OpenAI API key; subscriptions, other provider keys and ambient credentials cannot substitute. `imageGeneration:null` disables it. Setup makes no image request.

`image_generate` creates one synthetic PNG per run from a bounded prompt, with `1024x1024`, `1536x1024` or `1024x1536` size. It is not image search/editing, batches, automatic image understanding or a subscription entitlement. Only the prompt/model/size/quality are sent to the fixed OpenAI image endpoint; a model-composed prompt can still contain private details.

Trusted retained owner foreground mode, parent budgets/journals and one attempted request are enforced. There is no automatic retry after rejected/interrupted/uncertain acceptance. PNG/header/size checks establish neither visual quality nor prompt adherence. Cancellation, parsing or persistence failure cannot undo charges.

The TUI previews saved results; Telegram-originated work can attempt delivery only to its actual authenticated sender, with a separate receipt. Other channels do not implicitly upload. `asDocument:true` preserves file bytes instead of photo recompression. Generated-image operator APIs are `images.list`, `images.read`, `images.forget`; reads do not regenerate.

Private PNG files follow media retention; synthetic prompt/model/source metadata can outlive raw bytes. Generated content is assistant-authored, not factual evidence or an owner assertion. Source-aware forgetting removes managed images/derivatives, purges managed backups and preserves restore tombstones. Provider/Telegram/downloaded copies remain outside that guarantee.

## MCP integrations

[MCP](MCP.md) connects explicitly configured trusted servers over stdio, Streamable HTTP or legacy SSE, exposing selected tools plus resources/templates, prompts and argument completion. Private header/environment credentials and OAuth are separate from chat. Server read-only hints never grant permission: effects not explicitly delegated through exact `autonomousTools` need single-use owner-terminal approval; optional sampling and elicitation require fresh responses. Restricted/ephemeral work cannot dispatch MCP. Server output is evidence, not owner instructions or proof of success. Local servers are not sandboxed; remote services retain their own data and cost policies.

## Verification limits

Local tests exercise synthetic APIs, real subprocesses/SQLite/Unix transport and simulated terminals. Actual search-provider availability, Google grants, image access/quality, Telegram rendering/playback, model grounding and physical terminal behavior need separately authorized checks. [Testing](TESTING.md).
