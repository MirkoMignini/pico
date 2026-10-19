# Pikobot compared with OpenClaw and Hermes Agent

Updated: **19 October 2026** (original assessment: 18 October 2026). This is an architectural/product assessment, not a comparative runtime benchmark or security certification.

## Scope and evidence

- Pikobot revision: [`1a42aa0`](https://github.com/MirkoMignini/pikobot/tree/1a42aa03437989dd030120abb19c950a21e79b41); local source and documentation, including the merged installation/readiness work (#9), searchable documentation (#10) and browser MCP/desktop bridge (#11).
- [OpenClaw snapshot](https://github.com/openclaw/openclaw/tree/89207ad525fc581f59eaa6ed8c999474cb78b376), including its browser, subagent, heartbeat, skills, memory-provenance, usage and operations documentation.
- [Nous Research Hermes Agent snapshot](https://github.com/NousResearch/hermes-agent/tree/6f46e2b98cd986c795ed0095a13b570f41cbf2c0), including its execution, browser, delegation, memory, cron, security and webhook documentation.

The OpenClaw/Hermes snapshots remain those used on 18 October; their subsequent developments have **not** been reassessed. Upstream capabilities below are documented capabilities at those revisions, not independently verified release/runtime results. Pikobot's documented guarantees are design and regression-test boundaries, not proof of factual accuracy, isolation or production reliability. See [verification limits](TESTING.md).

## Conclusion

**Pikobot now has an installation/operations path and an interactive browser prototype, closing two implementation gaps in the original assessment. Its biggest gap is proving dependable, complete personal-assistant workflows, not rebuilding those foundations or adding another memory subsystem.**

- OpenClaw is the stronger reference for channels, interfaces, device integration and operations.
- Hermes is the stronger reference for general execution, delegation and learning from completed work.
- Pikobot's opportunity is a focused private personal/family assistant with inspectable evidence, controlled sharing and dependable delivery.

Borrow selectively rather than pursuing full feature parity. These are product judgments, not measured rankings of reliability or answer quality.

## Developments since the original assessment

- **Installation and readiness are implemented:** immutable version directories and atomic selection, explicit per-user launchd/systemd management, redacted non-starting doctor, guided setup and exact-model/account-bound test evidence. Configuration, stored credentials, observed authentication/reachability and test results remain separate; diagnostics do not run inference. Published release assets and real service-manager trials remain separate gates. [Installation/operations](INSTALLATION.md).
- **Browser MCP is implemented as an opt-in prototype:** a dedicated profile or explicitly paired personal Chrome through an authenticated desktop bridge/private tunnel, exact autonomous tool grants, human login/CAPTCHA handoff and receipt-linked snapshot/screenshot/download imports. This is no longer search/fetch only, but is not general browser parity or isolation. [Browser guide](BROWSER.md).
- **Documentation is easier to discover:** searchable [GitHub Pages guides](https://mirkomignini.github.io/pikobot/) build from the repository and publish after updates to `main`. This assessment and research proposals remain repository-only; better documentation is not evidence of live reliability.

## Current Pikobot capabilities against pinned upstream snapshots

| Area | Pikobot | OpenClaw / Hermes | Gap or recommendation |
| --- | --- | --- | --- |
| Memory | Source-backed facts, corrections, temporal/entity filters, original evidence and linked forgetting. | Persistent recall in both; OpenClaw documents provenance/deletion, Hermes combines curated notes, session search and optional providers. | Not a missing subsystem. Measure answer quality and improve inspection/correction. |
| Skills | Standard packages, scripts/assets, imports, generation, revisions and rollback. | OpenClaw Workshop/ClawHub; Hermes foreground/background skill creation and refinement. | Improve maintained content and the outcome-to-improvement feedback loop. |
| MCP | Tools/resources/prompts, OAuth, multiple transports, exact approvals and explicitly delegated autonomous tools. | Both support MCP. | Already present. Reuse it; autonomous effects remain distinct from owner-declared reads. |
| Interactive browser | Opt-in Playwright MCP: dynamic pages, clicks/typing/forms, screenshots/PDFs, handoff and receipt-linked imports; dedicated profile or explicitly paired personal Chrome bridge. | Both document navigation, snapshots, clicks, typing and screenshots. | Prototype delivered. Validate complete site workflows, handoff, remote deployment and vendor compatibility; bounded HTTP attachment capture is not universal download support. |
| General execution | Trusted skill scripts in temporary work copies, at most 60 seconds; native extensions can execute code. | First-class terminal/file tools, background processes and configurable execution environments. | Missing managed workspace/jobs, not the ability to execute code. Conditional priority for a personal assistant. |
| Delegation | One same-model, read-only web researcher per run. | Parallel/background subagents, monitoring and richer lifecycle controls. | Important for long investigations; start with bounded read-only jobs, not swarms. |
| Automation | Durable reminders, cron, bounded read-only scheduled agents, Gmail intake and deterministic rules. | OpenClaw heartbeat/event-driven automation; Hermes script/skill-backed jobs and external triggers. | Core scheduling exists; execution breadth is deliberately restricted. |
| Interfaces/channels | TUI and private Telegram, including separately configured voice/media. | OpenClaw documents many channels, web UI and device apps; Hermes broader messaging/desktop surfaces. | Reach and administration gap, not missing basic voice support. |
| Installation/operations | Versioned source installer, explicit per-user services, redacted doctor, guided readiness/model test, documented upgrade/rollback and searchable guides. | Guided installers, service management, richer doctor/update workflows. | Core path delivered. Harden release distribution and verify real platform supervision/recovery; source installation still requires pinned Node/pnpm. |
| Usage | Context estimate, recent usage and bounded auxiliary usage since boot. | Richer usage/cost/quota views and reporting. | Add durable accounting with explicit missing-data and estimate labels. |
| Everyday completeness | Documents, lists, agenda/reminders; scanned PDFs need OCR; local calendar lacks recurrence/all-day events. | Broader execution can address more tasks, without establishing accuracy. | Fix frequent everyday blockers before advanced orchestration. |

Pikobot's provenance, erasure, exact approvals and recipient-scoped sharing are useful differentiators, not grounds to claim competitors lack provenance or Pikobot is categorically safer. Extensions, skill scripts and local MCP servers retain OS-user access. Explicit browser autonomy includes website writes/sends without per-action approval, independently of Google/API write settings; a mistaken click can have irreversible effects.

## Verification status of the new capabilities

- **Operations:** local regressions cover installer selection/failure preservation, diagnostics, readiness binding and service guards. Installer build/package-manager steps and native manager commands are simulated in those suites; Linux/macOS CI is not a fresh registry installation, actual launchd/systemd trial or production upgrade check.
- **Dedicated browser:** a separately documented real Chrome/Playwright check used a fresh profile and synthetic loopback site, including dynamic DOM, imports and autonomous form submission. Default browser/bridge suites use synthetic backends over actual local transports/processes, not real websites or owner accounts.
- **Personal Chrome:** an initial owner-authorized check established pairing/navigation/screenshot import but failed download import. After the HTTP attachment fix, a new check captured/imported a CSV with exactly one GET and idempotent re-import; no inference was requested. A separate headless check covered compressed CSV/binary POST bytes and tab scoping. These are bounded synthetic-site results, not two-machine SSH, personal-profile form/handoff, live Telegram/model interpretation or general website compatibility.

These summarize recorded evidence in [testing](TESTING.md), not new trials performed for this document update. Missing acknowledgments remain uncertain, not successful or safe to replay.

## Prioritized remaining roadmap

### 1. Validate and harden the delivered operations path

The installer, services, doctor and readiness are no longer missing features. Finish adoption evidence: fresh-prefix installation with actual frozen dependency installation, separately authorized disposable macOS/Linux service trials, upgrade/recovery checks and reviewed versioned release assets. The existing `v0.1.0` tag predates the installer; a draft-release workflow is not a published, verified release.

Preserve the existing boundaries in `scripts/install.mjs`, `src/service.ts`, `src/doctor.ts` and `src/readiness.ts`: no implicit owner initialization, credential copying, daemon starts/restarts or billed probes. Keep **configured, credential present, authenticated, reachable and actually tested** distinct. Model-test evidence is exact-model/account-bound and daemon-lifetime only, not a durable quality history.

Acceptance: a fresh user can install, configure, diagnose, deliberately supervise and upgrade Pikobot without editing private JSON or reading sensitive logs. Verify actual daemon readiness and preservation/refusal of active work, not just service-manager exit codes. Real model access and connector delivery remain separate gates.

### 2. Package complete everyday workflows

Maintain a small set of generic skills: meeting preparation, document-to-action-items, weekly review, CSV analysis and source-cited research. Reuse existing documents, Google, planning, research and skills services, plus the explicitly configured browser where needed. Personal packages stay in private instances, not the repository.

Validate frozen synthetic scenarios, followed by separately authorized live-model/connector trials. Measure supported answers, actual effects, latency and cost, not tool-return status alone. Do not build a marketplace before maintaining a few excellent workflows.

### 3. Validate complete browser workflows and compatibility

Build on the delivered MCP preset/bridge rather than adding a native browser subsystem. New presets explicitly delegate an exact autonomous allowlist, including writes/sends; older configurations are not silently widened. Keep human login/CAPTCHA handoff, terminal-only resume, intention/result journals and source-linked imports. Personal Chrome requires explicit profile pairing; never discover/copy cookies, credentials or whichever browser happens to be active.

Prioritize separately authorized full workflows, graphical handoff and genuine two-machine SSH checks. HTTP attachment capture is bounded and excludes blob/JavaScript/range downloads; missing artifacts block completion and do not justify re-clicking or reading host Downloads. The personal bridge currently depends on reviewed Playwright MCP `0.0.83` tab-session internals; vendor upgrades need revalidation. Public web-fetch network restrictions do not constrain authenticated browser traffic.

### 4. Improve the skill-learning feedback loop

Pikobot already extracts memories, generates executable packages and proposes reusable procedural instructions. Connect **use → observed outcome → correction → tested revision → reuse**. Show what changed and why, bind test/outcome evidence to immutable revisions, and reuse disable/rollback. A zero exit code does not establish task correctness. Reuse `src/features/learning.ts`, `src/features/skills.ts` and `src/skills.ts`.

### 5. Make phone-first administration practical

Autonomous browser workflows can now run from trusted Telegram requests without per-action approval. Generic Google/MCP action reviews and browser handoff resume remain terminal-only, so phone-first administration is still incomplete. Consider a small explicitly paired owner control surface for those reviews, pending/failed work, receipts, attachments and memory corrections. Changing approval/resume authority needs authentication/security design with payload binding, expiry and single-use semantics, not just chat buttons.

### 6. Add managed background tasks when needed

Pikobot's researcher has a 60-second, four-request/eight-tool web/time boundary. Raising those numbers alone does not provide reliable delegation. Start with **start → inspect → cancel → collect → review interruption** for read-only research/document jobs, explicit child allowlists, shared budgets and durable result handoff. Do not automatically replay uncertain effects or permit recursive spawning initially. Reuse run/operation records in `src/runtime.ts` and `src/research.ts`.

## Foundations to improve alongside expansion

- **Execution containment:** generated native extensions activate in the daemon after syntax validation; scripts also retain OS-user access. Provide one clearly bounded execution option before encouraging third-party code or broader autonomy. Keep native extensions explicitly trusted. Temporary directories/process limits are not a sandbox; competitor isolation is optional too.
- **Usage accounting:** use canonical records for chat, extraction, embeddings, research and media; distinguish known/missing usage, per-feature totals and estimated prices. Admission limits are not guaranteed provider billing caps.

## Recommended sequence and non-goals

1. Verify installation/service/release acceptance using the delivered tooling.
2. Dependable everyday workflows, including complete browser tasks where needed, with separate quality/cost/effect evidence.
3. Learning visibility and durable usage accounting.
4. Paired mobile administration and bounded background tasks.
5. More channels/device integration only for demonstrated needs.

For personal/family use, consider scanned-document OCR and better appointment/reminder ergonomics before general terminal automation. Do not copy dozens of channels, public marketplaces, agent hierarchies, multiple cloud backends, silent provider failover or credential migration. Do not replace the memory engine without measured evidence of a problem.

**Target: an assistant that reliably handles a smaller set of personal tasks, explains its evidence and shows what actually happened. Breadth can follow.**

This update replaces the original Pikobot baseline claims with the merged revision above; it does not refresh upstream assessments or turn documented/fixture capabilities into live guarantees. Detailed behavior and limits remain in [installation/operations](INSTALLATION.md), the [browser MCP prototype](BROWSER.md) and [testing](TESTING.md).
