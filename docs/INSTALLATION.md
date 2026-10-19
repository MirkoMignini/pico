# Installation, diagnostics and service operation

Pikobot is early-stage software. These tools simplify operation; they do not establish live model quality, connector delivery or execution isolation. Native platforms: **macOS and Linux**. Node **24.21.0** and pnpm **11.2.2** are required. No installer changes your global runtime, shell profile, credentials or owner data.

The existing `v0.1.0` tag predates these installation tools. Use a reviewed checkout containing this guide until a subsequent version/tag and release assets are published. Do not assume an example release URL already exists. Git tags/source and checksums are not a security certification.

## Install from a reviewed source checkout

Select the pinned runtime/package manager, then:

```sh
node scripts/install.mjs --prefix "$HOME/.local/share/pikobot-app"
```

The default prefix is the same path shown above. `--source /absolute/reviewed/source` can select another checkout or an extracted source release. Installation:

1. Copies only application/build inputs into a private staging directory, without `.git`, owner instances, global plugins or credentials.
2. Runs frozen dependency installation with lifecycle scripts disabled, TypeScript checking and build. Package-registry access and dependency downloads are required; no inference or connector is configured/tested.
3. Removes development-only dependencies, verifies the compiled CLI's version and publishes `PREFIX/releases/VERSION` without overwriting an existing version.
4. Atomically selects that version with `PREFIX/current` and provides `PREFIX/bin/pikobot`. Older versions remain for deliberate rollback.

Add `PREFIX/bin` to your PATH yourself, or use the full path:

```sh
"$HOME/.local/share/pikobot-app/bin/pikobot" --version
"$HOME/.local/share/pikobot-app/bin/pikobot" --help
```

An installation lock serializes prefix changes. If the installer is killed, inspect its state and ensure no installer remains active before manually removing `PREFIX/.install-lock` and its abandoned `.staging-*` directory. Never remove `releases/`, `current` or an owner directory to clear a lock.

A release version is immutable. Reinstalling it is refused; `--activate VERSION` selects an already completed installation. Code changes need a new package version/release, not an overwrite of the same version. The source is trusted executable code; source-format checks are not a code audit.

## Initialize and configure one owner

Keep the application prefix separate from owner instances and from the source tree (including ancestors, descendants and symlink aliases). This prevents copying an installation's staging directory back into itself. Activation of an already installed version is separate and can be run from its installed installer.

Initialize an owner with:

```sh
pikobot --instance "$HOME/.local/share/pikobot" init --name "Your name"
pikobot --instance "$HOME/.local/share/pikobot" chat
```

Initialize a directory **once**. Never initialize over retained data or an existing backup. Ordinary `chat` starts/reconnects to its daemon unless a managed service is installed. Closing the TUI leaves the daemon running.

Open `/setup`. It shows local readiness and links to masked authentication, optional services, settings and a separately confirmed model test. Configure a model and your timezone; configure or disable hosted embeddings explicitly. Factory chat/extraction and embeddings can incur charges. See [setup](SETUP.md).

### Readiness is evidence, not a single green light

`/readiness` shows the selected conversation model and a separate background/extraction model when its default differs; CLI `readiness` shows the daemon's default model. The columns deliberately differ:

- **Enabled/configured:** settings and model-catalog availability, not service access.
- **Credential stored:** private credential present, not proof that it is valid or entitled.
- **Authenticated/reachable:** observed only after an explicit model request completes; not inferred from a saved key.
- **Tested:** `not-run`, `passed`, `failed` or `uncertain`. A completed but incorrect fixed answer is a failed test, even though the provider was reachable. An interrupted/error request can have charges; it is not retried automatically.

The model test sends only one fixed synthetic prompt, no history, private documents or tools, through the explicitly selected model/account. The TUI defaults to **Cancel** before this potentially billed request; CLI `auth test` explicitly requests a default-model test. Tests are remembered only during this daemon lifetime and tied to the exact model/credential bytes. Model/account/token changes (including OAuth refresh) can invalidate an observation; no silent new test occurs. This is not a historical audit log or general quality benchmark.

Optional embeddings, speech, transcription, images, search, Google and MCP require separate checks. The overview does not automatically contact them, refresh tokens or download weights. Google/MCP use their dedicated status/consent/catalog controls. Saved settings may differ from the running settings; `/reload` applies settings while idle, not compiled code. See [verification limits](TESTING.md).

## Diagnose without starting anything

```sh
pikobot --instance PRIVATE_INSTANCE doctor
pikobot --instance PRIVATE_INSTANCE doctor --offline --json
pikobot --instance PRIVATE_INSTANCE readiness
pikobot --instance PRIVATE_INSTANCE status
```

`doctor` never creates an instance/database, migrates data, loads instance extensions, installs/repairs packages, refreshes OAuth, runs inference or contacts connectors. By default it may contact only the selected existing Unix daemon's allowlisted `health` endpoint, with a three-second deadline. `--offline` disables even that connection. Exit code 1 indicates blocking local failures; warnings/unverified services are not passes at live reliability.

Checks cover runtime/platform, private paths/config/token metadata, disk headroom, a bounded SQLite-header read, local credential readiness and, when available, running-database `quick_check`, busy state and failure counts. **Offline inspection does not open SQLite**: WAL contents and full database integrity are unverified. An idle snapshot is not a maintenance lock. Never delete WAL/lock files or retry uncertain work to make doctor green.

Doctor returns fixed/allowlisted messages, not owner names/IDs, paths, credentials, addresses, documents, provider responses, module errors or private logs. `/doctor` offers the same report in the TUI without sending it to the model. Review any diagnostic before publishing it; arbitrary trusted native code is outside this reporting guarantee.

`status` remains a **private detailed snapshot** and can contain personal data. `status`, `readiness`, service status, help and version never start a daemon. A missing/legacy/unresponsive daemon is reported, not replaced. Start `serve` explicitly for private startup errors.

## Install an explicit per-user service

No root/system-wide service is installed. Service IDs are scoped to the immutable instance identity, not its display name.

```sh
pikobot --instance PRIVATE_INSTANCE service install
pikobot --instance PRIVATE_INSTANCE service status
pikobot --instance PRIVATE_INSTANCE service start
```

- **Linux:** a private unit in `~/.config/systemd/user/`, enabled for the user's default target. A working systemd user manager/session bus is required. Survival after logout or boot without login needs an operator decision about user lingering; Pikobot never enables lingering or uses sudo.
- **macOS:** a private LaunchAgent in `~/Library/LaunchAgents/`. It runs in the logged-in user's GUI launchd domain. It is not a system LaunchDaemon and does not promise pre-login operation.

`install` writes/registers the definition and enables future login startup, but does **not** start or restart a daemon now. Linux manager failure can leave installed definition/registration files; inspect status before intentionally retrying. `start` verifies an authenticated daemon health response, not merely a manager command's exit code. An already running daemon is never silently adopted/replaced or killed to clear its authority lock. If you opened chat before service installation, close its TUI and explicitly stop it with `pikobot --instance PATH rpc daemon.stop` while idle, then start the service. Unconfirmed ephemeral sessions are refused.

Once service registration exists, chat refuses to spawn a detached replacement if the daemon is down. Use `service start`, or inspect an uncertain/unhealthy startup rather than repeatedly starting processes.

Only HOME and a bounded executable PATH are configured in the service; provider credentials remain in the selected owner vault. There are no broad host/container mounts, environment-key imports or execution sandboxes. Native extensions retain full OS-user access. Systemd uses its user journal; launchd writes private `service-logs/stdout.log` and `stderr.log` under the instance. Logs may contain private startup errors and are not automatically rotated.

### Stop, restart or remove supervision

```sh
pikobot --instance PRIVATE_INSTANCE service stop --confirm-stop
pikobot --instance PRIVATE_INSTANCE service restart --confirm-stop
pikobot --instance PRIVATE_INSTANCE service uninstall --confirm-stop
```

Close **all** TUI/event clients first, preserve drafts/dialogs and finish active/queued/background work, delivery and sign-ins. The authenticated stop RPC refuses busy work, other in-flight RPCs and open event streams. It does not cancel work to succeed. `--confirm-stop` acknowledges loss of ephemeral sessions; retained data remains. Accepted effects/charges cannot be undone. There is no force option.

Stop is requested through authenticated instance IPC, not an untrusted PID file or broad process kill. Manager control follows graceful completion. An unresponsive service process is left for private inspection rather than force-stopped. An acknowledgment/start timeout is **uncertain**: inspect state before retrying. `uninstall` removes only the matching service definition/registration, not the owner, vault, database, logs, backups or application releases. Modified or unregistered definitions are not overwritten/deleted.

Managed installations use the stable prefix launcher, so a future explicit restart picks up `current`. Services installed from a source checkout pin that checkout's compiled entrypoint; stop/uninstall/reinstall deliberately if moving it. Native manager commands outside Pikobot bypass Pikobot's busy/draft guards; use them only with an independent maintenance plan. Native process limits are not execution isolation.

## Renamed installations

**This is a breaking rename, not an automatic migration.** The executable/package is `pikobot`, environment variables use `PIKOBOT_`, the operational database is `pikobot.sqlite`, and services use `ai.pikobot.*` (launchd) or `pikobot-*.service` (systemd). Default instance, application-prefix, browser-bridge and development-session paths also use the new name. No retired-name aliases or credential discovery are provided.

For an existing instance:

1. Using its previous build, preserve drafts, finish work, take a backup and gracefully stop/uninstall its service. Keep a private offline copy of the entire instance, including the latest deletion ledger and separate credential-recovery material. Do not initialize a replacement owner.
2. With **all** processes using that instance stopped, checkpoint its existing operational SQLite database before renaming it to `pikobot.sqlite`. Never discard a nonempty WAL or rename an open database. Leave `authority.sqlite`, owner/instance IDs, vault, source records and deletion history intact. Startup refuses to create a replacement database when a differently named SQLite file is present.
3. Install Pikobot in a separate application prefix. Update explicit instance paths, launch commands, environment variables and service registration. Reinstall supervision deliberately; do not edit a live service definition or keep two services owning one instance.
4. Review trusted extensions/skills, browser pairings and family peers before enabling them: API type names, script variables, protocol identifiers and citation schemes changed. Historical conversation metadata/citations and saved executable code are not rewritten; do not replay historical actions or bulk-replace owner content. Start a fresh conversation rather than reusing pre-rename model history. Re-pair compatible browser/family endpoints explicitly.
5. Inspect `doctor --offline`, then explicitly start the intended instance and check identity, retained records and delivery state. Verify providers/connectors separately; no inference probe is needed for the rename.

Existing backups keep their original filenames/hashes. Restore accepts exactly one manifest-listed SQLite database and stages it as `pikobot.sqlite`; it does not rewrite stored content or grant compatibility to old executable code/protocols. Never rename a backup member without updating and independently verifying its manifest. Git history and independently retained logs/data are not scrubbed by the rename.

A running development workspace also needs a deliberate supervisor/session relaunch after its private database and checkout path are moved. `pnpm dev:refresh` alone cannot migrate filenames, rename Herdr sessions or replace long-lived supervisors. Preserve this Pi session and all TUI drafts/dialogs before arranging that move; see [development](DEVELOPMENT.md).

## Upgrade and rollback

1. Preserve drafts/dialogs, finish work and create an application backup. Protect the latest deletion ledger and separate credential-recovery material.
2. Install the reviewed **new version** into the same application prefix. Dependency/build failure leaves `current` unchanged; publishing a new version does not restart existing daemons.
3. Close TUI clients and explicitly `service restart --confirm-stop` for the intended owner. A source-run daemon needs an equally deliberate graceful stop/start.
4. Inspect `doctor`, `readiness`, processing/delivery state and the running version. Reopen chat and verify the intended accounts/connectors separately.

To select an older already installed version:

```sh
node "$HOME/.local/share/pikobot-app/current/scripts/install.mjs" \
  --prefix "$HOME/.local/share/pikobot-app" --activate PREVIOUS_VERSION
```

Select that release's pinned Node first. Selection does not restart a daemon or roll back owner data. **Older code may refuse a newer schema.** Do not force a database downgrade; use the reviewed [offline recovery procedure](DEPLOYMENT.md#backup-and-restore), matching backup/build and latest deletion history. Failed/uncertain post-backup writes/deliveries are not safe to replay.

## Versioned source releases

Maintainers package an exact committed ref, never the dirty worktree or private Git history:

```sh
pnpm release:pack --output /new/private/output-directory --ref vNEXT_VERSION
```

The tag must match `package.json`. Packaging emits `pikobot-VERSION-source.tar.gz`, `SHA256SUMS` and a revision/hash `release.json`, excludes private/build paths, and rejects symlinks/submodules in selected inputs. It does not run tests, scan all semantic secrets, sign, publish or install anything. Review the committed public source and follow [release checks](TESTING.md#public-ci-and-release-checks).

The tag-triggered CI release job waits for Linux/macOS checks and the public-history secret scan before creating a **draft** GitHub release. Inspect it before publication. No tag, release or deployment is created by ordinary local development.

When real assets exist, download the source archive and checksum file from the same reviewed release, verify with `sha256sum --check SHA256SUMS` (Linux) or `shasum -a 256 --check SHA256SUMS` (macOS), inspect/extract it, and run its installer. A checksum detects corruption, not a compromised publisher/download origin. Never pipe a remotely fetched installer straight into a shell or borrow another application's credentials to get setup working.
