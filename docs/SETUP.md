# Setup and authentication

Use Node **24.21.0**, pnpm **11.2.2** and a POSIX environment with private files and Unix sockets. Install/build as shown in the [README](../README.md#quickstart). Each private instance has its own owner identity, database, vault and socket. Initialize it only once.

## TUI-first setup

Open `/setup` in a retained session. Setup dialogs replace the input area and are separate from agent conversation/history. Secrets are masked; never append them to a slash command or paste them into chat. Escape/Ctrl+C cancels a dialog.

| Control | Purpose |
| --- | --- |
| `/login [provider]`, `/logout [provider]` | Discover supported provider authentication methods or remove local credentials. |
| `/auth key PROVIDER` | Masked API-key entry for simple key providers. |
| `/auth secret NAME` | Masked auxiliary-service secret. |
| `/model`, `/model provider/id` | Inspect/select the current conversation's model. |
| `/model default provider/id` | Change new-conversation/background defaults, not existing conversations. |
| `/thinking [level]` | Choose supported reasoning; Ctrl+S in the selector also saves the global default. |
| `/settings` | Validated non-secret settings; identity/socket/code trust are not configurable here. |
| `/reload` | Apply saved settings while idle, not newly compiled code. |
| `/channels telegram setup` | Telegram bot token, numeric owner allowlist and reminder recipient. |
| `/integrations setup google` | Google settings and separate masked secrets. |
| `/auth test` | An explicit live inference request; may charge. |

Saving a credential does not test inference or connector access. Applying settings refuses active turns, background/delivery work, RPC and sign-ins. Retained data survives; **ephemeral sessions are lost**, with a UI warning. Failed application normally keeps the previous runtime and leaves saved settings pending for correction.

External bot creation, OAuth-client registration, browser consent, deployment and code upgrades are operator tasks, not settings overrides.

## Models, accounts and billing

Factory defaults:

| Service | Default |
| --- | --- |
| Chat and memory extraction | `deepseek/deepseek-flash` |
| Memory embeddings | OpenAI `text-embedding-3-small`, 1,536 dimensions |
| Thinking | `low`, clamped to the selected model |
| Web search | DuckDuckGo, no API key |
| Timezone | `Europe/Rome`; change it to your own |

For the defaults, use `/auth key deepseek` and `/auth key openai`. Enter each key only when its masked dialog opens. Both chat/extraction and hosted embeddings can incur charges. Existing instances keep their settings. Select different services explicitly; there is no provider/account fallback or discovery of environment, `~/.pi` or another application's credentials.

Pico uses the pinned Pi AI provider registry. `/login` handles multi-step provider flows; `/model` lists available choices. Availability metadata does not prove entitlement or live success. Provider terms, quotas and model IDs can change independently of Pico.

CLI alternatives, with hidden prompt or secure stdin entry—not secret arguments:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE auth key deepseek
node dist/cli.js --instance PRIVATE_INSTANCE login PROVIDER
node dist/cli.js --instance PRIVATE_INSTANCE rpc models '{"available":true}'
node dist/cli.js --instance PRIVATE_INSTANCE rpc model.default '{"provider":"PROVIDER","id":"MODEL_ID"}'
```

Chat models, embeddings, transcription, speech, image generation and research have separate configuration/cost boundaries. An OpenAI API key can be reused by explicitly enabled OpenAI auxiliary services; dedicated service secrets override it. A subscription token or another provider's key cannot substitute. Usage estimates are not invoices or spending caps.

## ChatGPT/Codex subscriptions

Use `/login openai` and select account sign-in, or `/login openai-codex` for Pi's separate Codex provider. Choose a model from that provider with `/model`. Pi owns login/refresh and request handling; account failures do not switch to an API key.

For remote/container use, prefer device-code login where the selected flow offers it:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE login openai-codex
```

The newer `openai` flow supports named ChatGPT account slots through `auth chatgpt LABEL`, `/auth accounts` and `/auth select ACCOUNT`. API credentials use `openai-api`; subscription slots use `chatgpt:LABEL`. Select intentionally; login can replace the chosen credential and logout does not revoke provider-side grants or accepted requests.

Browser flows may need a callback on `localhost:1455`; only one native listener can bind it at a time. Google uses the configured loopback callback port. Native listeners should stay on loopback. Container-only `PI_OAUTH_CALLBACK_HOST=0.0.0.0` must not be copied into native host configuration. Restrict remote callback forwarding to the intended owner/ports; see [deployment](DEPLOYMENT.md).

## Memory embeddings

Use `/settings embeddings` (or `/setup` → Memory embeddings), then apply:

- Hosted default: `{"provider":"openai","model":"text-embedding-3-small","dimensions":1536}`.
- Local alternative: `{"provider":"local","model":"Xenova/multilingual-e5-small","dimensions":384}`. Weights download/cache locally; provider embedding charges are avoided, not all model charges.
- `null`: disable embeddings and use lexical retrieval.

`/auth secret openai.embeddingKey` supplies a dedicated masked override; otherwise enabled hosted embeddings use the stored OpenAI API key. Background extraction still uses the configured chat model independently of embedding settings. No Mem0 platform account or vector server is needed. [Memory behavior](MEMORY.md).

## Telegram

1. Create a bot through Telegram's BotFather externally.
2. Run `/channels telegram setup`; enter the token in its masked field.
3. Supply your numeric private-chat owner IDs and select an allowlisted reminder recipient. **Every allowlisted ID has owner authority.** Do not add other people merely to receive their files.
4. Confirm/apply, open the bot and send `/start` or `/help` without inference.

`/telegram status` is local diagnostics. `/telegram check` explicitly makes read-only Bot API identity/webhook requests; it does not delete conflicting webhooks or another poller. Saving settings is not end-to-end acceptance. A disabled module stays disabled until `/extensions enable telegram`.

Private authorized messages only. Replies go to the actual sender; forwarded/bot content is evidence. Startup publishes `/start`, `/help`, `/new`, `/stop` and the Menu button best-effort. `/new` starts a saved conversation. Switching a configured bot namespace requires a separate instance, not silently reusing old cursors/receipts. [Supported content and delivery](CHANNELS.md#telegram-content-and-delivery).

## Voice transcription

Use `/settings transcription`, save `{"provider":"openai","model":"gpt-4o-mini-transcribe"}` and apply. `/auth secret openai.mediaKey` is the optional dedicated override; otherwise the enabled service uses the stored OpenAI API key. Merely saving a key does not enable transcription.

Verified incoming voice/audio can then be sent to OpenAI and supplied to chat as a labelled fallible transcript. Captions/context remain separate evidence; consequential recognition ambiguity warrants clarification. Forwarded audio remains untrusted evidence. Retained originals/transcripts follow source erasure; ephemeral ones stay volatile. Unknown transcription acceptance is not automatically rebilled. Subscription access is not transcription authentication.

## Voice replies: on-request text-to-speech

Use `/settings speech`, for example `{"provider":"openai","model":"gpt-4o-mini-tts","voice":"alloy"}`, and apply. `/auth secret openai.speechKey` overrides the stored OpenAI API key. `speech:null` disables it. Setup makes no speech request.

Ask for one voice answer, or “Always answer in voice in this chat.” The source-linked preference is scoped to the authenticated Telegram sender and Pico conversation, survives restart and resets with `/new`; text remains the default elsewhere. A one-off text request does not change the preference.

Only the bounded synthesis text goes to OpenAI; Ogg Opus is uploaded to the actual sender without a local audio archive. The exact synthesis transcript accompanies the voice, as a caption or complete literal follow-up. One attempted generation/upload per turn; accepted voice followed by transcript failure remains uncertain and is not resent automatically. Confirmed delivery replaces duplicate final text, not failure warnings. Providers/Telegram retain their own copies and can charge even when local delivery fails.

## Web and images

- `/setup` → Web search selects DuckDuckGo or optional Brave. Brave uses a masked `brave.searchKey`. `search:null` restores DuckDuckGo, not disabled browsing; disable the `web`/`research` modules to remove dispatch.
- `/settings imageGeneration` enables metered OpenAI generation, for example `{"provider":"openai","model":"gpt-image-1","quality":"low"}`. A masked `openai.imageKey` overrides the stored API key; `null` disables generation. Showing an existing retained image needs no generation key.

Setup/application does not run a search, image or model probe. [Feature behavior and limits](FEATURES.md).

## Google and other settings

Use `/integrations setup google`, `/integrations auth google` and `/integrations status google`. Cloud APIs/client creation and consent must be performed externally. Select services independently; remote writes start disabled and need exact terminal approval. [Google setup, scopes and limitations](GOOGLE.md).

`/settings timezone`, quiet hours, retention, transcription, embeddings, speech and image settings use validated non-secret JSON. Changes are applied with `/reload` while idle. The global/per-model/session thinking choices are preserved and clamped to the selected model; settings cannot change immutable owner/instance identity or grant executable-code permissions.

If a key entered chat, shell arguments or logs, revoke it and enter a replacement through a masked flow. Do not publish unredacted diagnostics. [Security](SECURITY.md).
