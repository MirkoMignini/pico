# Pico compared with OpenClaw and Hermes Agent

Assessment date: **18 October 2026**. This is an architectural/product assessment, not a comparative runtime benchmark or security certification.

## Scope and evidence

- Pico baseline: `6d860a3b007bd255ab057aa3e83398649cecc746`; local source and documentation, including the runtime, skills, scheduler, CLI, memory and security boundaries.
- [OpenClaw snapshot](https://github.com/openclaw/openclaw/tree/89207ad525fc581f59eaa6ed8c999474cb78b376), including its browser, subagent, heartbeat, skills, memory-provenance, usage and operations documentation.
- [Nous Research Hermes Agent snapshot](https://github.com/NousResearch/hermes-agent/tree/6f46e2b98cd986c795ed0095a13b570f41cbf2c0), including its execution, browser, delegation, memory, cron, security and webhook documentation.

Upstream capabilities below are documented capabilities at those revisions, not independently verified release/runtime results. Pico's documented guarantees are design and regression-test boundaries, not proof of factual accuracy, isolation or production reliability. See [verification limits](TESTING.md).

## Conclusion

**Pico already has a substantial personal-assistant foundation. Its biggest gap is turning it into an easy, dependable, broadly useful product, not adding another memory subsystem.**

- OpenClaw is the stronger reference for channels, interfaces, device integration and operations.
- Hermes is the stronger reference for general execution, delegation and learning from completed work.
- Pico's opportunity is a focused private personal/family assistant with inspectable evidence, controlled sharing and dependable delivery.

Borrow selectively rather than pursuing full feature parity. These are product judgments, not measured rankings of reliability or answer quality.

## Capability comparison at the baseline

| Area | Pico | OpenClaw / Hermes | Gap or recommendation |
| --- | --- | --- | --- |
| Memory | Source-backed facts, corrections, temporal/entity filters, original evidence and linked forgetting. | Persistent recall in both; OpenClaw documents provenance/deletion, Hermes combines curated notes, session search and optional providers. | Not a missing subsystem. Measure answer quality and improve inspection/correction. |
| Skills | Standard packages, scripts/assets, imports, generation, revisions and rollback. | OpenClaw Workshop/ClawHub; Hermes foreground/background skill creation and refinement. | Improve maintained content and the outcome-to-improvement feedback loop. |
| MCP | Tools/resources/prompts, OAuth, approvals and multiple transports. | Both support MCP. | Already present. Reuse it rather than building every integration natively. |
| Interactive browser | Public search/fetch and captured evidence; no JavaScript, cookies or interactive sessions. | Both document navigation, snapshots, clicks, typing and screenshots. | Major gap for dynamic/authenticated sites. Prototype with explicitly configured browser MCP first. |
| General execution | Trusted skill scripts in temporary work copies, at most 60 seconds; native extensions can execute code. | First-class terminal/file tools, background processes and configurable execution environments. | Missing managed workspace/jobs, not the ability to execute code. Conditional priority for a personal assistant. |
| Delegation | One same-model, read-only web researcher per run. | Parallel/background subagents, monitoring and richer lifecycle controls. | Important for long investigations; start with bounded read-only jobs, not swarms. |
| Automation | Durable reminders, cron, bounded read-only scheduled agents, Gmail intake and deterministic rules. | OpenClaw heartbeat/event-driven automation; Hermes script/skill-backed jobs and external triggers. | Core scheduling exists; execution breadth is deliberately restricted. |
| Interfaces/channels | TUI and private Telegram, including separately configured voice/media. | OpenClaw documents many channels, web UI and device apps; Hermes broader messaging/desktop surfaces. | Reach and administration gap, not missing basic voice support. |
| Installation/operations | Source checkout, pinned runtime, manual supervision/upgrades; doctor aliases status. | Guided installers, service management, richer doctor/update workflows. | Highest-priority adoption gap. |
| Usage | Context estimate, recent usage and bounded auxiliary usage since boot. | Richer usage/cost/quota views and reporting. | Add durable accounting with explicit missing-data and estimate labels. |
| Everyday completeness | Documents, lists, agenda/reminders; scanned PDFs need OCR; local calendar lacks recurrence/all-day events. | Broader execution can address more tasks, without establishing accuracy. | Fix frequent everyday blockers before advanced orchestration. |

Pico's provenance, erasure, exact approvals and recipient-scoped sharing are useful differentiators, not grounds to claim competitors lack provenance or Pico is categorically safer. Its extensions and skill scripts retain OS-user access.

## Prioritized roadmap

### 1. Make the existing assistant easy to operate

Provide a versioned installation/release path, explicit per-user service management, a genuinely useful redacted doctor, guided readiness and discoverable upgrade/recovery guidance. Show **configured, credential present, authenticated, reachable and actually tested** as distinct evidence; storing a key is not successful authentication or inference.

Reuse `src/cli.ts`, authenticated daemon APIs, existing setup dialogs and `deploy/`. Diagnostics must not silently start a daemon, migrate a database, load executable modules, refresh credentials, contact connectors or run billed probes. Installation must not initialize an owner, copy credentials or restart an existing owner. Service/restart commands must preserve active work and clearly distinguish installing, enabling and running.

Acceptance: a fresh user can install, configure, diagnose, deliberately supervise and upgrade Pico without editing private JSON or reading sensitive logs. Test clean installation and failures with disposable instances; OS service-manager checks, real model access and real connector delivery remain separate gates.

### 2. Package complete everyday workflows

Maintain a small set of generic skills: meeting preparation, document-to-action-items, weekly review, CSV analysis and source-cited research. Reuse existing documents, Google, planning, research and skills services. Personal packages stay in private instances, not the repository.

Validate frozen synthetic scenarios, followed by separately authorized live-model/connector trials. Measure supported answers, actual effects, latency and cost, not tool-return status alone. Do not build a marketplace before maintaining a few excellent workflows.

### 3. Prototype browser capability through MCP

Use an explicitly configured trusted browser server and a dedicated profile before introducing a native browser subsystem. Retain effect approvals, human login/CAPTCHA handoff and source-linked attachment imports. Do not borrow existing logins or classify an entire browser server as read-only to bypass friction. Generic MCP approval is not seamless browser parity or isolation.

### 4. Improve the skill-learning feedback loop

Pico already extracts memories, generates executable packages and proposes reusable procedural instructions. Connect **use → observed outcome → correction → tested revision → reuse**. Show what changed and why, bind test/outcome evidence to immutable revisions, and reuse disable/rollback. A zero exit code does not establish task correctness. Reuse `src/features/learning.ts`, `src/features/skills.ts` and `src/skills.ts`.

### 5. Make phone-first administration practical

Consider a small explicitly paired owner control surface for exact action reviews, pending/failed work, receipts, attachments and memory corrections. Terminal-only Google/MCP approval is an intentional security boundary but a real phone-first limitation. Changing it needs authentication/security design with payload binding, expiry and single-use semantics, not just chat buttons.

### 6. Add managed background tasks when needed

Pico's researcher has a 60-second, four-request/eight-tool web/time boundary. Raising those numbers alone does not provide reliable delegation. Start with **start → inspect → cancel → collect → review interruption** for read-only research/document jobs, explicit child allowlists, shared budgets and durable result handoff. Do not automatically replay uncertain effects or permit recursive spawning initially. Reuse run/operation records in `src/runtime.ts` and `src/research.ts`.

## Foundations to improve alongside expansion

- **Execution containment:** generated native extensions activate in the daemon after syntax validation; scripts also retain OS-user access. Provide one clearly bounded execution option before encouraging third-party code or broader autonomy. Keep native extensions explicitly trusted. Temporary directories/process limits are not a sandbox; competitor isolation is optional too.
- **Usage accounting:** use canonical records for chat, extraction, embeddings, research and media; distinguish known/missing usage, per-feature totals and estimated prices. Admission limits are not guaranteed provider billing caps.

## Recommended sequence and non-goals

1. Installation, doctor and readiness.
2. Dependable everyday workflows and evidence of their quality.
3. Learning visibility and durable usage accounting.
4. Browser MCP prototype.
5. Paired mobile administration and bounded background tasks.
6. More channels/device integration only for demonstrated needs.

For personal/family use, consider scanned-document OCR and better appointment/reminder ergonomics before general terminal automation. Do not copy dozens of channels, public marketplaces, agent hierarchies, multiple cloud backends, silent provider failover or credential migration. Do not replace the memory engine without measured evidence of a problem.

**Target: an assistant that reliably handles a smaller set of personal tasks, explains its evidence and shows what actually happened. Breadth can follow.**

This document preserves the baseline assessment; later implementation and its actual verification are documented in [installation/operations](INSTALLATION.md) and [testing](TESTING.md), not retroactively counted as baseline capabilities.
