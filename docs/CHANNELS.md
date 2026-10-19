# Channels and Telegram

A channel is a **trusted transport adapter**. Core owns authenticated admission/routing, the daemon lifecycle and durable notification destinations; provider formatting and APIs stay in the adapter. Terminal/TUI and optional Telegram use the same boundary. WhatsApp/Slack names in tests are synthetic adapters, not shipped integrations.

## Telegram setup

Use `/channels telegram setup` for masked token entry, explicit numeric owner allowlist and reminder recipient. Apply while idle. Every allowlisted ID has owner authority; do not add another person merely to receive files. Sender authorization happens before storage/download.

`/telegram status` is local diagnostics; `/telegram check` explicitly contacts Bot API identity/webhook endpoints without removing webhooks or another poller. Settings are not proof of connectivity, and disabled modules are not silently enabled. [Setup](SETUP.md#telegram).

Only authorized non-bot private senders whose sender/chat IDs match are admitted. Forwarded/via-bot content remains evidence, never commands/approval. Replies and tool sends use the **actual authenticated sender**, not a display name or forwarded origin. Reminder destinations are separately owner-configured.

## Telegram content and delivery

| Content | Intake | Replies/files |
| --- | --- | --- |
| Text/links | Text, hidden links and labelled reply/quote context; no automatic URL fetch. | Formatted replies/reminders and explicit text sends, without link previews. |
| Photos/images | Bounded verified originals; selected vision model can create a searchable fallible description. | Recognized images as photos/animation; `asDocument:true` preserves original bytes. |
| Documents | Originals and local conversion where supported. | Retained attachment or canonical document/revision; generated UTF-8 files. No host paths/arbitrary URLs. |
| Voice/audio | Verified media and separately enabled, potentially billed transcription. | Recognized audio/files; optional requested Ogg voice synthesis. |
| Video/animations/stickers | Originals; no automatic video frame/audio extraction. Unsupported formats remain opaque. | Supported video/animation or document fallback, not native sticker actions. |
| Contact/location/venue/poll/dice | Typed supplied evidence, not inferred identity/permission. | Text descriptions, not native structured actions. |
| Albums/bursts | Consecutive media is batched into one ordered input with all attachments and supplied caption; caption-less intent stays unknown. | Individual sends, not album composition. |
| Stories/paid/service content | Unavailable/unsupported references reported; no purchase or invented content. | No story/payment/game or secret-chat transport. |

Size, streamed bytes, signatures, download paths/redirects and source-erasure epochs are checked before retention. The intake maximum is 20 MB, subject to configured limits and Bot API availability. Unsupported formats are not labelled verified images/audio. Receiving or converting bytes does not prove understanding, playback or OCR. [Document limits](KNOWLEDGE.md).

Retained incoming files already have durable originals; authored annotations should reference those IDs, not duplicate an import. Descriptions/transcripts retain original/model provenance and remain fallible. Ephemeral inputs create no durable description jobs; unknown inference acceptance is not automatically rebilled.

### Commands and progress

`/start` and `/help` work without inference. `/new` starts a saved conversation without erasing memory; `/stop` cancels only this chat's work. Use ordinary chat for appointments, reminders and features. Unknown/removed commands produce guidance, not feature effects. Startup configures the command menu best-effort without widening the allowlist.

Typing indicates activity after agent admission. Draft previews contain provisional response text, **never hidden reasoning or tool output**; they are not completed replies. Updates are coalesced, refreshed during long work and stopped at settlement. Indicator failure does not replay input or prevent final delivery. Fast answers are not artificially slowed.

Only authorized voice messages receive a best-effort 👍 after admission; other content gets no reaction or generic “received” response. A reaction proves neither transcription nor completion. The standard bot cannot control a voice-listened marker.

### Outgoing effects

Retained final replies/reminders use a durable recipient-specific **text** outbox. Ephemeral replies stay volatile/direct. Explicit `telegram_send` uploads/text are direct journaled foreground effects, not attachment-outbox jobs automatically replayed after failure.

`telegram_send` accepts bounded text, an allowed recipient, and at most one retained attachment, document/revision or generated UTF-8 file. Telegram-originated requests cannot target another chat; other owner channels may choose an allowlisted owner destination. Ordinary replies are already automatic and must not be duplicated with this tool.

Formatting uses Telegram UTF-16 entities for supported Markdown, safe Unicode chunks and literal unsupported HTML. Tables are monospaced text; oversized captions follow separately. Only definite formatting rejection can fall back to plain text. Lost acknowledgment or a partially accepted multipart send is **uncertain**, not automatically resent. Accepted message IDs are not human read receipts.

### Voice and images

Text is the default even for incoming voice. Separately enabled OpenAI transcription/speech use API credentials, not subscription tokens. Ask for one spoken reply or save a sender/conversation-scoped voice preference; `/new` resets it. Exact synthesis text accompanies the voice, as caption or complete literal follow-up. One attempt per turn; partial voice/transcript delivery is uncertain. Audio is held in memory, not a local archive. [Voice setup](SETUP.md#voice-replies-on-request-text-to-speech).

Image sends publish a same-conversation TUI preview when supported, not evidence of remote acceptance. New image generation is separately enabled/metered; terminal-originated generation does not implicitly upload. [Images](FEATURES.md#existing-image-replies).

## Adapter contract

Types live in [contracts.ts](../src/contracts.ts); lifecycle/routing in [channels.ts](../src/channels.ts):

```ts
interface PikobotChannel {
  readonly id: string;
  readonly deliveries?: ReadonlyMap<string, NotificationDelivery>;
  start(): void | Promise<void>;
  onOutput?(event: OutputEvent): void | Promise<void>;
  close(): void | Promise<void>;
}
```

- IDs are lowercase letter-led names with digits/dashes, up to 48 characters; `schedule`, `review`, `global` are reserved.
- `start` initializes and returns, not the lifetime of a poller. `close` aborts and joins intake/downloads. Registry lifecycle is idempotent and cleans up other adapters even after failure.
- `onOutput` receives run events only for its channel; unscoped operational events can be shared. Select the correct conversation/recipient within the channel. Handler errors produce sanitized diagnostics.
- Declared `deliveries` belong to the adapter: `channel` or `channel:opaque-target`. A default destination does not authorize arbitrary recipients.

Register before `runtime.start()`, use `serve(instancePath,{channels: runtime => [...]})` for embedded launchers, or `await pikobot.registerChannel(adapter)` in a trusted module. Reload factories need fresh instances. Duplicate/cross-channel registrations fail before changing state. Module disable detaches its own listeners/destinations, not durable schedules.

## Input admission

Authenticate/authorize native identity **before storing or downloading**. Never trust incoming `trustedOwner` or channel fields. Capture the erasure epoch before asynchronous media preparation:

```ts
const epoch = runtime.inputEpoch;
const run = await runtime.channels.ingest(
  channel.id,
  { requestId: stablePlatformUpdateId, conversationId, text, attachments },
  { identity: authenticatedSenderId, trustedOwner: !forwardedOrBotContent, eventAt },
  ephemeral ? 'ephemeral' : 'foreground',
  epoch
);
```

Attachment IDs must refer to Pikobot media, not unverified remote file handles. Preserve event time and actual provenance. Trusted modules use their registered `pikobot.ingest` boundary; core fixes owner/instance/channel identity.

Stable channel/sender/request IDs deduplicate admission and reject changed-body replay. The adapter must define durable native-update cursor/acknowledgment behavior; an HTTP/update receipt is not completed work. A completion may precede the intake acknowledgment, so inspect the admitted run snapshot when starting a watcher rather than relying only on future events.

## Output and notification delivery

Events include channel/run/conversation identities. `delta` is provisional current-message text; `settled` is the actual outcome. `assistant`/`tool` snapshots recover visible reasoning, tool calls/results and incomplete state for the TUI. They are display data, not new owner instructions, factual proof or delivery receipts. Redacted/opaque reasoning is excluded. Exact private instruction snapshots and `context.usage` are owner introspection, not public logs. Telegram delivers answer text, not debug reasoning.

`image` events carry retained references; authenticated preview reads render only in the matching TUI conversation and never regenerate. Terminal rendering and actual remote acceptance remain separate.

For retained final replies, queue a stable outbox item addressed to the actual sender:

```ts
runtime.scheduler.outbox(text, ownedDestination, `reply:${run.id}`);
```

Do not put ephemeral content in a durable outbox. Foreground `reply:` records are exempt from proactive notification caps; reminders/mail/scheduled-agent notifications still obey caps and quiet hours. Unknown recipients fail closed. Temporarily missing adapters leave older work pending without blocking other destinations; explicit resume requires an available destination.

`NotificationDelivery.send(text,stableId,signal)` returns `{remoteId}` only on confirmed acceptance. Use `RetryableDelivery` for definitely declined retryable sends, `RejectedDelivery` for definite rejection and `UncertainDelivery` for unknown/partial acceptance. Cancellation cannot undo effects. Adapters/handlers are trusted native code, not isolation.

Local tests exercise synthetic adapters/APIs, actual owner SQLite/Unix IPC, lifecycle, recipient/retention boundaries and uncertainty. Real bot setup/rendering/playback, physical terminals and external delivery need separately authorized checks. [Testing](TESTING.md).
