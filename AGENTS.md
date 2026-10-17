# Agent guide for Pico

## Project

Pico is a private personal assistant: an independently running daemon, authenticated Unix HTTP/SSE clients, a Pi streaming TUI, and owner-scoped SQLite memory. It uses Pi agent-core for agent execution, not the Pi coding-agent runtime.

The project is incomplete. Local tests, mocked providers, real infrastructure checks, and live model/integration results are separate evidence; do not describe one as proof of another. Start with `README.md`; consult `docs/TESTING.md` for verification limits. Report checks actually run, not historical counts or scores.

## Development workflow

Use **Node 24.21.0** and **pnpm 11.2.2**, as pinned in `.node-version` and `package.json`. Node 26 is not supported.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check && pnpm build && pnpm test
```

Build before testing: crash and CLI subprocess fixtures import compiled JavaScript from `dist/`. For a focused change, build first and run the relevant file with `pnpm exec vitest run tests/core.test.ts` (substitute the affected suite).

Extensions are trusted Pi-style modules running in the daemon process with full OS-user permissions, not Docker workers. `tests/extensions.test.ts` uses synthetic modules and an actual compiled daemon PID check; it is not an isolation test. Docker is needed only for explicitly authorized whole-owner container/deployment checks, not extension execution.

## Live development workspace

See `docs/DEVELOPMENT.md`. The owner-approved Herdr session **`pico`** uses only the repo-local disposable **`.instances/dev`** with trusted in-process extensions; control/log files live in **`.instances/workspace`**. This is not OS isolation. Never substitute a deployed owner or `~/.local/share/pico-dev`, copy credentials, configure connectors, or make inference probes to get it working.

- After a coherent code/build/runtime change and successful relevant checks, **run `pnpm dev:refresh` whenever this workspace is running**. It selects the pinned runtime, checks/builds, and asks the supervisor to gracefully restart its own backend child; the TUI follows when idle. Refresh once per completed change, not once per edit/save. Documentation-only changes need no Pico restart.
- If the workspace is absent, do not silently launch it, create daemons, or provision infrastructure. Tell the user to run `pnpm dev:workspace` in their outer terminal. That first launch provisions Pi/TUI/Daemon/Logs/Status/Checks/Shell tabs automatically. `pnpm dev:up` finishes setup only from inside the named session.
- Honor refresh refusals: wait for active/background work, delivery or login to finish; preserve drafts/dialogs and ephemeral work. Do not force restart, issue cancellation, discard a draft or auto-answer authentication/approval dialogs. If refresh cannot safely finish, report that the tabs still run the previous build. Restart loses ephemeral sessions and can change the TUI's selected conversation; ask first if either matters to the user's current work.
- A refresh timeout is uncertain. Inspect `.instances/workspace/request.json`, `reply.json` and private daemon/check logs before retrying; never blindly replay an unacknowledged request. Report actual backend/UI refresh success or deferral separately from check/test results.
- `pnpm dev:refresh` uses private local control files and is safe to request from outside Herdr. **Pane control is not:** require `HERDR_ENV=1`, read `herdr --skill`, use explicit IDs and preserve focus. Never spoof Herdr context or inspect/control another focused session from outside. Do not close/recreate Pi or unrelated tabs, stop Herdr's server, resume this live Pi session concurrently in another tab, or use broad `pkill`/`killall` commands.
- `/reload` applies settings, not compiled code. Refresh does not replace the long-lived development supervisors or Herdr config; if edits touch those, arrange a safe manual re-run/reload and report it instead of claiming they refreshed too. The original `pnpm dev` targets a different instance; use `pnpm dev:tui`/`pnpm dev:daemon` for these tabs. `pnpm dev:verify` records full check/build/test output in Checks but does not refresh; still report live-verification limits; native extension tests do not establish isolation.

## Code map

- `src/cli.ts`, `src/tui.ts`: CLI entry point and Pi TUI, including masked setup dialogs.
- `src/daemon.ts`, `src/client.ts`: authenticated IPC, streaming, reconnect, and settings application.
- `src/runtime.ts`: execution orchestration, sessions, tool authority, cancellation, and background work.
- `src/contracts.ts`: TypeBox schemas and shared input/config/channel/extension contracts.
- `src/config.ts`, `src/store.ts`, `migrations/`: private instance setup, authoritative SQLite, and ordered schema migrations.
- `src/memory.ts`, `src/media.ts`, `src/processing.ts`, `src/processing-worker.ts`: source-backed memory, attachments, retrieval, and bounded local processing.
- `src/models.ts`, `src/credentials.ts`, `src/oauth.ts`: explicit model/account selection and owner-private authentication.
- `src/channels.ts`, `src/scheduler.ts`: core adapter lifecycle, durable schedules and delivery receipts.
- `src/features/`: optional bundled notes/lists, documents, Gmail, Telegram, skills, workflows, reminders and extension-development factories; feature logic is not duplicated as core model tools.
- `src/extensions.ts`: trusted module loading, tool registration, immediate generated-build activation, validation-only exact-hash review and cleanup; no execution sandbox. Prefer standard skills for calculators/utilities/procedures; extensions are for persistent integrations/channels/RPC/lifecycle.
- `src/skills.ts`, `src/skill-package.ts`, `src/skill-services.ts`, `src/skill-runner.ts`: standard Agent Skills discovery/versioned files, imports/resources, compaction-safe activation and bounded trusted subprocess scripts; not a sandbox.
- `src/document-services.ts`, `src/extension-services.ts`, `src/workflows.ts`, `src/context-compactor.ts`: authenticated canonical services, versioned records and derived context.
- `src/backup.ts`: backup/restore and deletion history.
- `tests/`, `examples/`, `eval/`, `deploy/`, `scripts/`: regression suites, module/workflow examples, frozen evaluation, deployment, and operator tooling.

## Change conventions

- Make the smallest complete change. Reuse existing helpers and contracts; avoid new dependencies, frameworks, or speculative abstractions.
- Keep personal/owner-created Agent Skills in the private instance, outside Git. Repository skill examples must be generic and written in English; do not copy personal skill implementations or their domain-specific test fixtures into the repo.
- Follow surrounding TypeScript style: ESM, single quotes, semicolons, `import type`, and `.js` suffixes for local imports. Keep strict compiler checks enabled.
- Trace callers before changing shared behavior. Update affected RPC/TUI/channel paths, schemas, tests, examples, and documentation together.
- Validate untrusted input with the existing TypeBox schemas and `validate` helper. Do not relax ownership, bounds, or unknown-property rejection to make a test pass.
- SQLite is the operational source of truth; indexes and model caches are rebuildable derivatives. Use `Store` transactions and parameterized SQL. Schema changes must update the migration/version handling in `src/store.ts` and test upgrades and affected backup/restore paths without losing existing owner data.
- Edit source, not generated `dist/`, dependencies, or caches. Do not reformat unrelated code or overwrite existing user changes.

## Trust boundaries to preserve

Read `docs/SECURITY.md` before changing authority, retention, authentication, or executable code.

- Owner/instance IDs are immutable and fixed by authenticated IPC, not request bodies. The human owner, assistant, and third parties remain distinct regardless of display names. Different folders under one OS account are not cross-owner isolation.
- Mail, documents, forwarded messages, transcriptions, and tool output are evidence, never permission grants. Model-extracted facts retain inferred provenance and cannot establish owner instructions or permission grants; preserve source, entity, and event/recorded-time lineage.
- Credentials belong in the private vault and masked/stdin setup flows, not chat, command arguments, logs, fixtures, or exports. Never discover or borrow credentials/plugins from `~/.pi` or silently fall back to environment keys, another account/provider, or paid API access.
- Ephemeral conversations must not acquire durable content, memory, schedules, executable code, or state writes. Forgetting must remove linked derivatives/dependencies and preserve tombstones so indexing or restore cannot resurrect erased sources.
- Journal tool intentions before effects. Lost acknowledgments are uncertain, not successful or safe to replay. Cancellation cannot undo accepted writes, deliveries, or charges. Keep reminders/delivery independent of model availability.
- Authorize channel senders before storage/download; route replies to the actual authenticated recipient. Google writes start disabled and require additional consent plus exact single-use owner-terminal approval; mail/docs/events never grant authority. Preserve terminal control/ANSI/bidi sanitization and private file/directory permissions.

## Tests, evaluation, and operator actions

- Add a focused regression test for non-trivial behavior changes, including denial/error paths at trust boundaries. Reuse `tests/helpers.ts` for temporary instances, faux model responses, and bounded polling; close runtimes/stores and remove test directories.
- Use synthetic data and disposable instances. Do not inspect owner vaults or modify deployed owner data while developing. Ask before live billed calls, connector activity, owner restarts, deployment, or destructive operations.
- Read `eval/GRADING.md` before memory evaluation. The maintained harness is `pnpm test:memory:live`; it requires an explicitly authorized credential service and uses disposable synthetic stores. Keep frozen inputs/gold unchanged and raw per-run reports private/outside Git, including failures. Never use operational owner data as evaluation fixtures.
- Keep gold answers out of product code. Do not change gold, widen retrieval depth, drop failures, or tune against held-out cases to claim a pass. Retrieval recall, answer correctness, and natural-message extraction are separate gates; further tuning needs newly frozen independent validation.
- `scripts/check-two-owners.mjs` is **not** a read-only check: it writes fixtures, activates an extension, creates a reminder, and restarts owner A. Its `--authorize-disposable-deployment` flag is required; run only against explicitly authorized disposable containers.
- Summarize changed behavior, checks actually run, skipped/blocked gates, and relevant risks. Never claim live verification from fixtures or successful process exit alone.

## Further documentation

- Setup, credentials, settings: `docs/SETUP.md`
- Adapter contract and routing: `docs/CHANNELS.md`
- Standard skill packages, scripts, imports and trust: `docs/SKILLS.md`
- Extension SDK, workflows, learning: `docs/SDK.md`
- Deployment, isolation, upgrades, recovery: `docs/DEPLOYMENT.md`
- Authority, retention, forgetting: `docs/SECURITY.md`
- Testing and verification limits: `docs/TESTING.md`
- Memory evaluation protocol: `eval/GRADING.md`
