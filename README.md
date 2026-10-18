<h1 align="center">
  <img src="docs/assets/pico.svg" alt="Pico — your space, your assistant" width="480">
</h1>

<p align="center"><strong>A self-hosted, chat-first personal assistant with memory.</strong></p>
<p align="center">Remember what matters. Organize your day. Chat in your terminal or on Telegram—with text, files and voice.</p>
<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#what-pico-can-do">Features</a> ·
  <a href="#channels">Channels</a> ·
  <a href="#family-collaboration">Family</a> ·
  <a href="#mcp-integrations">MCP</a> ·
  <a href="https://mirkomignini.github.io/pico/">Documentation</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="LICENSE">MIT license</a>
</p>

> **Early development.** Pico is not production-hardened. Models can make mistakes, integrations require their own setup, and passing local tests does not establish live reliability. Read the [security model](docs/SECURITY.md) and [testing limits](docs/TESTING.md) before trusting important work to it.

## What Pico can do

| | |
| --- | --- |
| **Remember with sources** | Recall preferences and facts with original evidence, corrections, dates and source-aware forgetting. |
| **Organize information** | Markdown notes, checklists, preserved document originals, local conversion, search and citations. |
| **Plan and remind** | Local appointments, a combined agenda, and durable reminders that do not depend on model availability. |
| **Share selectively** | First-version [family links](docs/FAMILY.md) between same-host instances: explicitly authorized reminders and per-list read/edit access, without sharing private memory or owner credentials. |
| **Chat where you work** | A streaming terminal UI and optional private Telegram bot with text, voice messages, spoken replies, photos, documents and more. [Explore channels](#channels); more are planned. |
| **Research the web** | DuckDuckGo search, optional Brave, captured pages and bounded read-only research. |
| **Connect selectively** | Optional Gmail, Google Docs, Calendar, Contacts, Drive, Sheets and Tasks. Google writes start disabled and require exact owner approval. |
| **Connect MCP servers** | Use selected external tools, resources and prompts through the [MCP client](#mcp-integrations), over stdio, Streamable HTTP or legacy SSE, with private credentials/OAuth and owner-controlled approvals. |
| **Add useful skills** | Standard Agent Skills packages with scripts/assets, chat creation and imports. Trusted extensions handle persistent integrations and daemon hooks. |

Everyday use is conversational:

- “Remember that I prefer vegetarian meals.”
- “Create a packing checklist with passport, charger and jacket.”
- “What did the report I uploaded say about the budget? Cite the source.”
- “Add a dentist appointment tomorrow from 09:00 to 10:00.”
- “Remind me tomorrow at 08:30 to bring those documents.”
- “Create a reusable text-analysis skill, test it, then use it on this file.”

These are examples, not guaranteed command templates. Check receipts and sources for consequential actions. Appointments do not automatically create reminders. Try the [no-credentials demo](docs/DEMO.md) for deterministic skills and disposable local collaboration checks.

## Family collaboration

**Separate assistants, selectively shared tasks.** Link two owner instances after both owners authorize each other's public identity. Then use ordinary conversation, including Telegram, to send consented reminders and collaborate on individual checklists:

- “Remind Bob in two minutes to bring the parcel.”
- “Create a groceries list shared with Bob.” — creates and shares it in one operation, with read/write access.
- “Share my groceries list with Bob.” — read/write by default; say “read-only” to restrict it.
- From Bob's Pico: “Add milk to Alice's shared groceries list.”
- “Stop sharing my groceries list with Bob.”

Lists stay in their owner's instance; **“shared” means read/write unless you explicitly request read-only**. Access applies only to that checklist, not private memory, conversations, files or credentials. The recipient controls reminder delivery. Revocation stops new access and pending family reminders; accepted deliveries cannot be recalled.

**First-version limits:** same-host Unix sockets with compatible OS permissions, bilateral pairing from the owner terminal, no Internet federation or automatic whole-family sharing. Do **not** add collaborators to the same Telegram owner allowlist. Examples require the actual configured aliases and completed pairing; they are not live-model guarantees.

[Pairing and permissions](docs/FAMILY.md) · [Step-by-step manual checks](docs/FAMILY.md#manual-acceptance-walkthrough) · [Disposable local integration check](docs/TESTING.md#family-collaboration)

## MCP integrations

**Bring selected tools and data sources into your assistant.** Pico is a Model Context Protocol **client**, built on the official TypeScript SDK; it does not expose Pico itself as an MCP server. Configure trusted servers, then ask Pico to use their capabilities in ordinary conversation.

- **Tools and data:** namespaced tools with schema validation, resource/template discovery and reads, reusable prompts, argument completion, progress and change notifications.
- **Connections and accounts:** local stdio processes, Streamable HTTP and legacy HTTP/SSE; private environment/header credentials or OAuth with PKCE, token refresh and explicit client-credentials grants.
- **Optional interactions:** owner-reviewed form/URL elicitation and bounded text sampling, explicit advisory roots and experimental legacy tasks. Sampling is off by default and can charge your selected model.
- **Owner-controlled effects:** only exact tools explicitly declared read-only can execute directly. Other tool calls prepare an expiring, single-use action for `/mcp approve ACTION_ID`; server annotations never grant permission. MCP tool dispatch is denied in ephemeral, scheduled and other restricted work.

Start in the TUI, replacing `SERVER` with an ID from your saved configuration:

```text
/mcp setup
/mcp connect SERVER
/mcp status
/mcp catalog SERVER
```

No servers are installed or connected by default. Saving settings does not connect immediately; enabled servers connect on daemon startup or when explicitly requested. If needed, enter credential JSON only through `/mcp secret SERVER` (masked) and complete browser consent with `/mcp auth SERVER`. The [setup examples](docs/MCP.md#setup) include a public, credential-free Microsoft Learn server; the selected Pico model still has its own inference costs.

**Trusted servers, not a sandbox.** Local servers run with your OS-user permissions; remote servers receive your arguments and apply their own retention/cost policies. Declaring a tool read-only is delegated trust, not proof that a server cannot write. Returned content is evidence, never permission, and cancellation cannot undo accepted effects.

[Full capabilities and configuration](docs/MCP.md) · [CLI/RPC and approvals](docs/MCP.md#cli-and-rpc) · [Verification and limits](docs/MCP.md#verification)

## Channels

**Two channels today: the terminal UI (TUI) and Telegram, with more to come.** Both connect to the same private Pico instance and its memory, documents, skills and enabled integrations, while keeping separate conversations. Choose the TUI for detailed inspection and administration, or Telegram to carry your assistant with you. The daemon keeps running independently of the terminal client.

### Terminal UI (TUI)

A streaming, keyboard-first workspace for chatting with Pico and managing your instance.

| Feature | What you can do |
| --- | --- |
| **Live conversation** | Streaming Markdown replies, a scrollable transcript, multiline editing, sent-message history and slash-command completion. Drafts remain editable during work and are never sent automatically. |
| **Thinking and tools** | Expand/collapse available Thinking and tool details, including arguments, results, status and timings. Ctrl+O toggles all boxes; individual headers are clickable. |
| **Saved conversations** | Start with `/new`, switch with `/sessions`, and recover history and active-run state after reconnecting. New chats do not erase shared memory. |
| **Model controls** | Choose accounts/models and reasoning levels; see the current model, thinking level, context estimate and integration status. |
| **Images** | Preview retained and generated images in supported terminals, with labelled fallbacks otherwise. Image generation requires separate setup. |
| **Setup and credentials** | Provider, Telegram, Google and MCP setup; masked secret entry, browser consent, settings and idle reloads without leaving the TUI. Secrets stay out of chat. |
| **Administration** | Manage skills/extensions and MCP connections, review exact Google/MCP action approvals and optional MCP interaction requests, inspect notifications, and create backups/exports. |
| **Work and notifications** | Follow progress and background notifications, request cancellation with Escape or `/stop`, and detach with `/quit` without stopping the daemon. |

The TUI is text-first: it does not record/play voice or upload a file from a typed path. Import host documents through the [operator CLI](docs/KNOWLEDGE.md#operator-commands), or attach them in Telegram. See [essential controls](#essential-controls) below.

### Telegram

Your own optional bot for **private, allowlisted owner chats**—not group chats or a public multi-user bot. Configure it through `/channels telegram setup` in the TUI. **Every allowlisted ID has owner authority**; replies go to the actual authenticated sender.

| Feature | What you can do |
| --- | --- |
| **Text, links and context** | Chat with formatted replies, code blocks and text tables. Captions, hidden link destinations, replies, quotes and forwarded context are preserved as evidence; URLs are not fetched automatically on receipt. |
| **Voice messages and audio** | Send voice notes or supported audio files. Separately enabled transcription supplies a labelled transcript to the assistant, so you can ask questions or request actions by voice. |
| **Spoken replies** | Ask for one voice answer or “Always answer in voice in this chat.” Optional speech synthesis sends an Ogg voice message with the exact spoken text. Text is the default; `/new` resets the chat-scoped voice preference. |
| **Photos and images** | Send photos/images and retain originals; a configured vision model can add searchable descriptions. Receive saved or separately enabled generated images, as photos or original-byte documents. |
| **Documents** | Upload files for original preservation, supported local conversion, search and source-cited answers. Receive retained attachments, canonical document revisions or generated UTF-8 files. |
| **Video, animations and stickers** | Retain incoming originals, including video notes and stickers. Supported outgoing media uses video/animation or file delivery; there is no automatic video frame/audio extraction or native sticker sending. |
| **Albums and media bursts** | Consecutive media is batched into one ordered input with attachments and captions. Outgoing files are sent individually, not composed into albums. |
| **Shared structured content** | Supply contacts, locations, venues, polls and dice as labelled evidence. Replies describe them in text rather than creating native Telegram actions. |
| **File and media delivery** | Request sends of retained files, supported images/audio/video or generated text files. Document delivery can preserve original bytes rather than photo recompression; arbitrary host paths and URLs are not upload sources. |
| **Progress feedback** | Typing indicators and provisional answer drafts during work—never hidden reasoning or tool output. Incoming voice notes also get a best-effort 👍 intake reaction, not a completion receipt. |
| **Reminders and replies** | Durable text replies and configured reminder delivery, independent of an open TUI. Accepted delivery is not a human read receipt; uncertain sends are not automatically replayed. |
| **Conversation controls** | `/start` and `/help` work without inference; `/new` starts a saved chat; `/stop` requests cancellation of that chat's work. Use ordinary conversation for assistant features. |

**Audio needs separate setup:** [transcription](docs/SETUP.md#voice-transcription) and [voice replies](docs/SETUP.md#voice-replies-on-request-text-to-speech) are independently enabled OpenAI API services and can incur charges. Receiving a voice message alone does not enable either service or switch replies to voice. Image descriptions/generation also depend on configured services.

Incoming files are limited to **20 MB**, subject to configured limits and Telegram availability. Unsupported formats may remain opaque: retaining media does not mean Pico can understand or play it. Stories, paid-content unlocking, payments, games and secret chats are not supported. See [Telegram setup](docs/SETUP.md#telegram) and the [full content/delivery contract](docs/CHANNELS.md#telegram-content-and-delivery) for details.

### More channels to come

TUI and Telegram are the currently shipped channels; additional channels are planned. Pico's [channel adapter contract](docs/CHANNELS.md#adapter-contract) lets trusted extensions add transports while reusing core routing, lifecycle and notification delivery. Planned channels are not available integrations yet.

## Quickstart

**Requirements:** Node.js **24.21.0**, pnpm **11.2.2**, and a POSIX environment with Unix sockets and private file permissions. Node 26 is not supported. Docker is optional.

```sh
git clone https://github.com/MirkoMignini/pico.git
cd pico

# Select the pinned Node and pnpm versions first.
# Install into an immutable version directory; no owner/service is created.
node scripts/install.mjs --prefix "$HOME/.local/share/pico-app"
export PATH="$HOME/.local/share/pico-app/bin:$PATH"

pico --instance "$HOME/.local/share/pico" init --name "Your name"
pico --instance "$HOME/.local/share/pico" chat
```

Initialize each directory only once. The chat client starts or reconnects to that instance's daemon; closing the client leaves the daemon running. Optional `pico --instance PATH service install` / `service start` provide explicit per-user launchd/systemd supervision; installation alone does not start it. `doctor --offline --json` checks local setup without starting a daemon or contacting providers. [Installation, service operation, upgrades and recovery](docs/INSTALLATION.md).

These installer tools require a checkout containing this guide; the original `v0.1.0` tag predates them. For direct source development, use `pnpm install --frozen-lockfile --ignore-scripts && pnpm check && pnpm build`, then `node dist/cli.js` instead of the installed `pico` launcher.

In Pico, open `/setup` to configure your model and optional services. Factory defaults are **DeepSeek Flash** for chat and **OpenAI text-embedding-3-small** for memory embeddings; both can incur charges. For those defaults:

```text
/auth key deepseek
/auth key openai
```

Enter keys **only in the separate masked dialogs**, never in chat or command arguments. Use `/login` and `/model` to choose another supported account/model; `/settings embeddings` selects local or disabled embeddings. Local embeddings do not make model-driven memory extraction free or offline. Setup shows readiness without running inference; an explicit model test requires separate confirmation and may charge.

See [setup](docs/SETUP.md) for provider accounts, costs, settings, Telegram and optional services.

### Essential controls

| Control | Purpose |
| --- | --- |
| `/new`, `/sessions` | Start or select a saved conversation. `/new` does not erase memory. |
| `/model`, `/thinking` | Select the conversation's model and reasoning level. |
| `/setup`, `/readiness`, `/doctor` | Guided setup, separate configuration/authentication/test evidence, and redacted local diagnostics. No automatic probes. |
| `/settings`, `/reload` | Configure services and apply saved settings. `/reload` does not deploy code. |
| `/stop`, `/notifications` | Request cancellation or inspect delivery state. |
| `/skills`, `/extensions` | Inspect and administer installed packages/modules. |
| `/mcp setup`, `/mcp status` | Configure trusted MCP servers, credentials and tool approvals. |
| `/backup`, `/export` | Manage private owner data. |
| `/help`, `/quit` | Show controls or leave the client without stopping the daemon. |

Drafts stay editable during work but are never sent automatically. Escape interrupts a turn or cancels a dialog; Ctrl+O toggles Thinking/Tool details. Terminal image previews depend on graphics support. To import a host document, use the operator CLI or attach it in Telegram; a typed path is not an upload.

## Your data, your instance

Pico runs an independent daemon with authenticated HTTP/SSE over a Unix socket. SQLite holds canonical records, evidence and execution receipts; search indexes and model caches are rebuildable. It uses Pi's **agent-core, AI and TUI libraries**, not the coding-agent runtime.

- **One instance, one owner identity.** Use separate OS/container boundaries for mutually untrusted owners; two folders under one OS user are not isolation.
- **Self-hosted is not offline.** Selected model providers and enabled connectors receive the data needed for their work and have separate retention policies. Pico does not silently switch accounts/providers or borrow ambient credentials.
- **Saved chats are retained.** Forgetting removes linked managed derivatives and protects restores with tombstones; it cannot erase provider copies, downloaded files or OS snapshots. Backups exclude the credential vault and need a separate credential-recovery plan.
- **Actions have consequences.** Routine local writes and generated skills/extensions need no mandatory confirmation. Cancellation cannot undo an accepted write, delivery or charge; uncertain effects are not safe to replay.
- **Executable code is trusted.** Extensions run inside the daemon; skill scripts and local MCP servers run as the OS user. None is sandboxed. They can read accessible files/credentials, use the network and damage data. Syntax checks are not a security audit.

Keep personal skills in the private instance, not this repository. The [English text-statistics sample](examples/skills/text-statistics/SKILL.md) demonstrates the portable format; examples are not installed automatically.

## Documentation

**[Read the documentation online →](https://mirkomignini.github.io/pico/)** — searchable guides, rebuilt automatically from this repository on every update to `main`.

| Guide | Start here for… |
| --- | --- |
| [Installation/operations](docs/INSTALLATION.md) | Versioned installs, redacted doctor, per-user services, upgrades and recovery. |
| [Setup](docs/SETUP.md) | Accounts, masked credentials, readiness, settings and optional services. |
| [Features](docs/FEATURES.md) | Agenda/reminders, web research and images. |
| [Memory](docs/MEMORY.md) · [Documents](docs/KNOWLEDGE.md) | Sources, extraction, search, notes/lists and forgetting. |
| [Telegram/channels](docs/CHANNELS.md) · [Google](docs/GOOGLE.md) | Integration setup, routing, capabilities and approval boundaries. |
| [Family collaboration](docs/FAMILY.md) | Same-host owner pairing, consented reminders, shared checklists, revocation and first-version limits. |
| [Attachment research](docs/ATTACHMENTS-RESEARCH.md) | Phone-first, app-by-app capture taxonomy, basic/advanced processing proposals, sources and current limitations—not a shipped-feature guide. |
| [MCP](docs/MCP.md) | Trusted servers, tools/resources/prompts, OAuth, exact approvals and interoperability checks. |
| [Skills](docs/SKILLS.md) · [Extension SDK](docs/SDK.md) | Reusable packages, scripts, trusted integrations and workflows. |
| [Security](docs/SECURITY.md) · [Deployment](docs/DEPLOYMENT.md) | Trust, retention, backups, recovery and optional containers. |
| [Demo](docs/DEMO.md) · [Development](docs/DEVELOPMENT.md) · [Testing](docs/TESTING.md) | No-credentials examples, contributor tools, verification and its limits. |
| [OpenClaw/Hermes assessment](docs/COMPARISON.md) | Baseline comparison, gaps, priorities and deliberate non-goals. |

## Contributing

Pico is TypeScript/ESM on Node, with strict TypeBox contracts and SQLite migrations. Start with [CONTRIBUTING.md](CONTRIBUTING.md); coding agents should also read [AGENTS.md](AGENTS.md).

```sh
pnpm check && pnpm build && pnpm test
```

Build before testing: subprocess fixtures import compiled JavaScript. Use disposable instances and synthetic data; do not commit credentials, personal skills, instance data or raw evaluation reports. Live model calls, connectors, deployments and owner restarts require explicit authorization.

## License

[MIT](LICENSE) © 2026 Mirko Mignini. Dependencies retain their own licenses. Reused web-extraction material and cached public test fixtures keep their [Pi skill](docs/licenses/pi-skills.txt) and [AnyDoc fixture](tests/fixtures/knowledge/PUBLIC-LICENSE.txt) notices.
