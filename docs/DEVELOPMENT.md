# Pico development workspace

From this repository in an **outer terminal**:

```sh
pnpm dev:workspace
```

Requires Herdr and Pi on `PATH`. `scripts/dev.sh` selects the pinned Node **24.21.0** from your current PATH, Homebrew or mise; it refuses another version or pnpm other than **11.2.2**. It does not change your global Node or terminal configuration.

The launcher checks/builds, starts the named Herdr server **`pico`** only if absent, and attaches a client using your global Herdr config. The server keeps a repo-private config for Pico's pane startup and window title; its first pane provisions these tabs:

| Tab | Purpose |
|---|---|
| Pi | Fresh interactive coding-agent session in this repository; no initial model prompt and no concurrent resume of another Pi session |
| TUI | Pico chat against the workspace daemon; restarts with new compiled UI code when idle |
| Daemon | Visible development supervisor and its owned backend subprocess; crash failures stay visible rather than being replayed |
| Logs | Follow private daemon lifecycle/tool/diagnostic logs; no conversation/delta/notification/auth-prompt bodies |
| Status | Read-only authenticated health snapshot every three seconds, including model, runs, extension execution, channels and pending indexing |
| Checks | Follow check/build/test output, including refresh compile failures |
| Shell | Project shell for tests, RPC experiments and refresh commands |

The client reads the same global config as your default session (`~/.config/herdr/config.toml`, or under `XDG_CONFIG_HOME`): keybindings, theme and sidebar layouts are not copied or merged. Server-only settings still come from `.instances/workspace/herdr.toml`. Its shell wrapper leaves unrelated spaces in their own directory; only Pico's directory, explicitly assigned Pico roles, or explicit development commands enter this repository. After editing shared client settings, use Herdr's UI **reload config** action. To switch an already-attached client from the old private config, detach and reattach once.

Use your usual Herdr tab/space shortcuts or the mouse. **Ctrl+b, then q** detaches with the default prefix; re-run `pnpm dev:workspace` to attach again. Detaching does not stop the processes. Neither provisioning nor refresh closes unrelated panes or modifies Herdr's global config. `pnpm dev:up` inside this session finishes partially provisioned layouts without duplicating already recorded tabs. If a Herdr mutation failed without acknowledgment, inspect the visible tabs before retrying: a missing receipt does not prove nothing was created.

## Instance and authentication

This workspace uses only **`.instances/dev`**, initialized once with a separate immutable owner/instance identity. Its control state/config/logs are in **`.instances/workspace`**. Both are ignored by Git and use private directories/files. Existing `~/.local/share/pico-dev`, deployed owners, credentials and connectors are untouched. Re-launching/refreshing preserves the development database and credentials; there is no automatic reset, import or credential copying.

Pico ships default-on feature modules, including local calendar/agenda planning and image generation; the latter makes no request until metered settings are explicitly enabled. [Image setup/limits](FEATURES.md#image-generation). `/extensions enable MODULE` and `/extensions disable MODULE` control dispatch without deleting saved data. Core services and durable reminder delivery remain independent. DuckDuckGo web search is the default, with optional masked Brave setup via `/setup` → **Web search**; queries/fetches and selected-model research happen only when tools are invoked, not during workspace launch/refresh. [Web/privacy limits](FEATURES.md#web-search-and-research). [Module map and API](SDK.md).

Standard [skills](SKILLS.md) discover automatically from `.instances/dev/skills/` and `.instances/dev/.agents/skills/`; use chat for creation/import and scripts/assets. No restart is required for package edits. A calculator is normally a skill, not a permanent daemon extension. Skill scripts run as the OS user in temporary work copies with bounded subprocesses, **not an OS sandbox**; no dependencies, credentials or connectors are automatically provisioned.

**Trusted extensions run in-process, as requested.** Module imports/factories and tools have your full OS-user access. New extension builds are syntax-checked and then activate immediately without confirmation in trusted retained owner foreground work, delegating full executable-code trust to the model. Validation-only artifacts and existing pending approvals remain inert until exact-hash terminal approval; manually installing local files already expresses that trust. This is not isolation; the repo-local directory does not protect your other data or credentials. Prefer synthetic data and a disposable OS account/VM. No model authentication, inference probe, connector configuration or billed call is performed by these scripts. Configure the fresh **Pico TUI** yourself with `/login` and `/model`; Pi authentication is separate. Once you configure Pico, its normal foreground/background work and connectors can make network calls and incur charges.

`pnpm dev` targets `~/.local/share/pico-dev`; **do not use it for these tabs**. Use `pnpm dev:tui` instead.

## Apply completed code changes

```sh
pnpm dev:refresh
```

This asks the workspace supervisor to:

1. Refuse refresh during TUI drafts/dialogs, active/queued/background work, delivery, pending login or an in-flight RPC.
2. Run `pnpm check` and `pnpm build`, recording output in Checks. Compilation failure leaves the current processes running.
3. Recheck idleness, gracefully close only its own backend child, start the new compiled backend, and acknowledge its readiness.
4. Let the TUI load the new compiled UI when it has no draft/dialog/turn. Pi, logs, status and shell keep running.

Run refresh once after a coherent edit and relevant tests, not after every file write. `/reload` applies settings, **not JavaScript**. Refresh replaces compiled Pico and its backend/TUI worker processes, not the long-lived development supervisors themselves: edits to the launcher/supervisor portions of `scripts/dev.*` require re-running the affected tab commands; Herdr config changes need an explicit config reload/relaunch. Idle guards are momentary, not a multi-user maintenance lock: don't type into Pico while applying a refresh. A new draft/dialog after the final check delays UI replacement instead of discarding it.

A backend restart loses **ephemeral sessions**; retained conversations, settings, memory and credentials survive. The new TUI selects a retained conversation, not necessarily the conversation you previously selected. Cancellation/restart cannot undo accepted deliveries, writes or charges. If ephemeral work or selected-session continuity matters, postpone refresh.

The refresh command also works from an agent outside Herdr because it uses owner-private request/receipt files, not pane control. It verifies the authenticated backend PID against the workspace's ready record and never signals arbitrary PIDs or uses `Client.ensureDaemon` to start a hidden daemon. Concurrent refresh commands are serialized with an OS-backed SQLite lock. A timed-out, unacknowledged refresh is **uncertain**, not permission to replay it: inspect `request.json`, `reply.json` and Daemon first. A restarted supervisor never replays an old request. Only after confirming its outcome may you archive/remove that stale `request.json` control file to allow a new request; do not delete the development database.

A busy refusal is not an error to force through. Wait for work to settle or explicitly finish/cancel it yourself, then retry. Report a stale/deferred workspace when refresh cannot safely complete.

## Verification and recovery

```sh
pnpm dev:verify  # check, build, full tests; output in Checks
pnpm dev:refresh # apply only after verification succeeds
```

`dev:verify` is not a file watcher and does not restart Pico. Extension tests need no Docker; they verify trusted native execution, not isolation. Whole-owner deployment verification remains a separate authorized gate. For a focused suite, use the pinned runtime and build first, as described in `AGENTS.md`.

- `/quit` closes only the TUI. In that tab, run `pnpm dev:tui` to open it again.
- Backend crash: inspect Daemon and Logs, then run `pnpm dev:daemon` in the Daemon tab after the supervisor exits. The TUI/status tabs wait for that managed backend; they never start a detached replacement.
- Closing a tab is different from detaching. **Provisioning does not recreate recorded-but-closed tabs.** Create a new tab manually and run `pnpm dev:daemon`, `pnpm dev:tui`, `pnpm dev:status`, or `tail -F .instances/workspace/{daemon,checks}.log` as appropriate. Run `pi` for the coding-agent tab.
- Full Herdr server/session stop is outside refresh. Restored shells may need their commands re-run; this launcher does not install Herdr integrations or promise native Pi conversation restore. Don't delete `.instances/dev` to fix layout problems.
- To stop development, stop the TUI with `/quit` and the supervisor with Ctrl+C in Daemon. Only an explicit operator action should stop the named Herdr session; never stop the default session to refresh Pico.

Logs are debugging derivatives, not a complete audit trail, and diagnostic/check output can include file paths or sensitive errors. They are private but not automatically rotated; don't publish them unreviewed. No terminal transcript or model-content log is added. The normal Pico database remains the operational authority.
