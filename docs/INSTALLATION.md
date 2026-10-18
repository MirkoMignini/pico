# Installation, diagnostics and service operation

Pico is early-stage software. These tools simplify operation; they do not establish live model quality, connector delivery or execution isolation. Native platforms: **macOS and Linux**. Node **24.21.0** and pnpm **11.2.2** are required. No installer changes your global runtime, shell profile, credentials or owner data.

The existing `v0.1.0` tag predates these installation tools. Use a reviewed checkout containing this guide until a subsequent version/tag and release assets are published. Do not assume an example release URL already exists. Git tags/source and checksums are not a security certification.

## Install from a reviewed source checkout

Select the pinned runtime/package manager, then:

```sh
node scripts/install.mjs --prefix "$HOME/.local/share/pico-app"
```

The default prefix is the same path shown above. `--source /absolute/reviewed/source` can select another checkout or an extracted source release. Installation:

1. Copies only application/build inputs into a private staging directory, without `.git`, owner instances, global plugins or credentials.
2. Runs frozen dependency installation with lifecycle scripts disabled, TypeScript checking and build. Package-registry access and dependency downloads are required; no inference or connector is configured/tested.
3. Removes development-only dependencies, verifies the compiled CLI's version and publishes `PREFIX/releases/VERSION` without overwriting an existing version.
4. Atomically selects that version with `PREFIX/current` and provides `PREFIX/bin/pico`. Older versions remain for deliberate rollback.

Add `PREFIX/bin` to your PATH yourself, or use the full path:

```sh
"$HOME/.local/share/pico-app/bin/pico" --version
"$HOME/.local/share/pico-app/bin/pico" --help
```

An installation lock serializes prefix changes. If the installer is killed, inspect its state and ensure no installer remains active before manually removing `PREFIX/.install-lock` and its abandoned `.staging-*` directory. Never remove `releases/`, `current` or an owner directory to clear a lock.

A release version is immutable. Reinstalling it is refused; `--activate VERSION` selects an already completed installation. Code changes need a new package version/release, not an overwrite of the same version. The source is trusted executable code; source-format checks are not a code audit.

## Initialize and configure one owner

Keep the application prefix separate from owner instances:

```sh
pico --instance "$HOME/.local/share/pico" init --name "Your name"
pico --instance "$HOME/.local/share/pico" chat
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
pico --instance PRIVATE_INSTANCE doctor
pico --instance PRIVATE_INSTANCE doctor --offline --json
pico --instance PRIVATE_INSTANCE readiness
pico --instance PRIVATE_INSTANCE status
```

`doctor` never creates an instance/database, migrates data, loads instance extensions, installs/repairs packages, refreshes OAuth, runs inference or contacts connectors. By default it may contact only the selected existing Unix daemon's allowlisted `health` endpoint, with a three-second deadline. `--offline` disables even that connection. Exit code 1 indicates blocking local failures; warnings/unverified services are not passes at live reliability.

Checks cover runtime/platform, private paths/config/token metadata, disk headroom, a bounded SQLite-header read, local credential readiness and, when available, running-database `quick_check`, busy state and failure counts. **Offline inspection does not open SQLite**: WAL contents and full database integrity are unverified. An idle snapshot is not a maintenance lock. Never delete WAL/lock files or retry uncertain work to make doctor green.

Doctor returns fixed/allowlisted messages, not owner names/IDs, paths, credentials, addresses, documents, provider responses, module errors or private logs. `/doctor` offers the same report in the TUI without sending it to the model. Review any diagnostic before publishing it; arbitrary trusted native code is outside this reporting guarantee.

`status` remains a **private detailed snapshot** and can contain personal data. `status`, `readiness`, service status, help and version never start a daemon. A missing/legacy/unresponsive daemon is reported, not replaced. Start `serve` explicitly for private startup errors.

## Install an explicit per-user service

No root/system-wide service is installed. Service IDs are scoped to the immutable instance identity, not its display name.

```sh
pico --instance PRIVATE_INSTANCE service install
pico --instance PRIVATE_INSTANCE service status
pico --instance PRIVATE_INSTANCE service start
```

- **Linux:** a private unit in `~/.config/systemd/user/`, enabled for the user's default target. A working systemd user manager/session bus is required. Survival after logout or boot without login needs an operator decision about user lingering; Pico never enables lingering or uses sudo.
- **macOS:** a private LaunchAgent in `~/Library/LaunchAgents/`. It runs in the logged-in user's GUI launchd domain. It is not a system LaunchDaemon and does not promise pre-login operation.

`install` writes/registers the definition and enables future login startup, but does **not** start or restart a daemon now. Linux manager failure can leave installed definition/registration files; inspect status before intentionally retrying. `start` verifies an authenticated daemon health response, not merely a manager command's exit code. An already running daemon is never silently adopted/replaced or killed to clear its authority lock. If you opened chat before service installation, close its TUI and explicitly stop it with `pico --instance PATH rpc daemon.stop` while idle, then start the service. Unconfirmed ephemeral sessions are refused.

Once service registration exists, chat refuses to spawn a detached replacement if the daemon is down. Use `service start`, or inspect an uncertain/unhealthy startup rather than repeatedly starting processes.

Only HOME and a bounded executable PATH are configured in the service; provider credentials remain in the selected owner vault. There are no broad host/container mounts, environment-key imports or execution sandboxes. Native extensions retain full OS-user access. Systemd uses its user journal; launchd writes private `service-logs/stdout.log` and `stderr.log` under the instance. Logs may contain private startup errors and are not automatically rotated.

### Stop, restart or remove supervision

```sh
pico --instance PRIVATE_INSTANCE service stop --confirm-stop
pico --instance PRIVATE_INSTANCE service restart --confirm-stop
pico --instance PRIVATE_INSTANCE service uninstall --confirm-stop
```

Close **all** TUI/event clients first, preserve drafts/dialogs and finish active/queued/background work, delivery and sign-ins. The authenticated stop RPC refuses busy work, other in-flight RPCs and open event streams. It does not cancel work to succeed. `--confirm-stop` acknowledges loss of ephemeral sessions; retained data remains. Accepted effects/charges cannot be undone. There is no force option.

Stop is requested through authenticated instance IPC, not an untrusted PID file or broad process kill. Manager control follows graceful completion. An unresponsive service process is left for private inspection rather than force-stopped. An acknowledgment/start timeout is **uncertain**: inspect state before retrying. `uninstall` removes only the matching service definition/registration, not the owner, vault, database, logs, backups or application releases. Modified or unregistered definitions are not overwritten/deleted.

Managed installations use the stable prefix launcher, so a future explicit restart picks up `current`. Services installed from a source checkout pin that checkout's compiled entrypoint; stop/uninstall/reinstall deliberately if moving it. Native manager commands outside Pico bypass Pico's busy/draft guards; use them only with an independent maintenance plan. Native process limits are not execution isolation.

## Upgrade and rollback

1. Preserve drafts/dialogs, finish work and create an application backup. Protect the latest deletion ledger and separate credential-recovery material.
2. Install the reviewed **new version** into the same application prefix. Dependency/build failure leaves `current` unchanged; publishing a new version does not restart existing daemons.
3. Close TUI clients and explicitly `service restart --confirm-stop` for the intended owner. A source-run daemon needs an equally deliberate graceful stop/start.
4. Inspect `doctor`, `readiness`, processing/delivery state and the running version. Reopen chat and verify the intended accounts/connectors separately.

To select an older already installed version:

```sh
node "$HOME/.local/share/pico-app/current/scripts/install.mjs" \
  --prefix "$HOME/.local/share/pico-app" --activate PREVIOUS_VERSION
```

Select that release's pinned Node first. Selection does not restart a daemon or roll back owner data. **Older code may refuse a newer schema.** Do not force a database downgrade; use the reviewed [offline recovery procedure](DEPLOYMENT.md#backup-and-restore), matching backup/build and latest deletion history. Failed/uncertain post-backup writes/deliveries are not safe to replay.

## Versioned source releases

Maintainers package an exact committed ref, never the dirty worktree or private Git history:

```sh
pnpm release:pack --output /new/private/output-directory --ref vNEXT_VERSION
```

The tag must match `package.json`. Packaging emits `pico-VERSION-source.tar.gz`, `SHA256SUMS` and a revision/hash `release.json`, excludes private/build paths, and rejects symlinks/submodules in selected inputs. It does not run tests, scan all semantic secrets, sign, publish or install anything. Review the committed public source and follow [release checks](TESTING.md#public-ci-and-release-checks).

The tag-triggered CI release job waits for Linux/macOS checks and the public-history secret scan before creating a **draft** GitHub release. Inspect it before publication. No tag, release or deployment is created by ordinary local development.

When real assets exist, download the source archive and checksum file from the same reviewed release, verify with `sha256sum --check SHA256SUMS` (Linux) or `shasum -a 256 --check SHA256SUMS` (macOS), inspect/extract it, and run its installer. A checksum detects corruption, not a compromised publisher/download origin. Never pipe a remotely fetched installer straight into a shell or borrow another application's credentials to get setup working.

## Implementation verification (18 October 2026)

Checks actually executed for this change:

- Pinned frozen installation, TypeScript check/build and the full local regression suite; documentation/link and whitespace checks. Providers and ordinary native-manager commands in those suites are synthetic.
- A real fresh-prefix installation with actual production dependencies, plus a second installation from a checksum-verified source archive. The latter used a new disposable committed snapshot of the current public-allowlisted source, not a published release, copied Git history or deployed owner.
- An actual disposable macOS LaunchAgent: install without start, plist validation, native start and authenticated health, redacted doctor, refusal to restart with an open event client, graceful restart retaining a synthetic note and owner identity, then uninstall preserving owner data. Only its own unique temporary service was controlled.
- An unfiltered production audit: the existing high-severity `braces` advisory remains as documented in [security](SECURITY.md#dependency-checks); this is not a clean audit.

Linux systemd execution, a published/hosted release download, independent secret-scanner execution, vendor authentication, billed inference and real Google/Telegram delivery were **not** verified by these checks. No owner credentials were borrowed and no release/tag/deployment was published. Local and macOS success must not be described as those separate gates. Raw per-run reports/logs stay private outside Git.
