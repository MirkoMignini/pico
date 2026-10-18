# Deployment and recovery

For one trusted local owner, run Pico natively. The daemon uses authenticated Unix HTTP/SSE, not a public HTTP listener. Use the explicit [per-user service helpers](INSTALLATION.md#install-an-explicit-per-user-service) for launchd/systemd, or an independently managed supervisor. Native user services start with a user login/session; they are not system-wide boot services. Versioned installs, redacted diagnostics and safe restart instructions are in [installation/operations](INSTALLATION.md).

```sh
node dist/cli.js --instance PRIVATE_INSTANCE serve
```

Do not start a second daemon for the same directory or copy a live owner/channel into another running instance. Native SQLite authority locking releases on process death; deleting a lock is not permission to start a duplicate.

## Trust and resources

Extensions run in the daemon; skill subprocesses still have OS-user permissions. They can access that owner's files/vault/network, incur charges, corrupt state or block delivery. Separate directories do not isolate mutually untrusted owners. Use constrained OS accounts/containers/VMs where needed; container/host administrators remain trusted. [Security](SECURITY.md).

Semantic document retrieval can download roughly 2.1 GB of private model weights and use several GiB of native RAM. Budget for originals, indexes, backups and peak worker memory; monitor disk capacity. V8 heap bounds are not whole-process limits, and volumes have no automatic filesystem quota.

## Optional Docker examples

Build explicitly; no infrastructure is provisioned during normal setup:

```sh
docker build -f deploy/Dockerfile -t pico-app:0.1.0 .
```

The image uses pinned Node/pnpm, a non-root application user and a private `/data` volume. `deploy/two-owners.sh` is an **operator-managed example**, not a hosted multi-tenant service. It creates two separate owner volumes/networks, configures container callback ports, applies read-only roots/resource limits, and starts their daemons. It refuses existing containers and reuses existing identities rather than reinitializing their volumes.

Read the script before authorizing it. Its names are `pico-owner-a`/`pico-owner-b`; control metadata is under `PICO_DEPLOY_ROOT` or the operator's private deployment directory. Never expose a Docker socket or broad host mount to an owner container.

For that example:

```sh
docker exec -it pico-owner-a node /app/dist/cli.js --instance /data chat
docker exec pico-owner-a node /app/dist/cli.js --instance /data status
docker logs --tail 100 pico-owner-a
```

Logs/status can contain private data. The optional checker is **mutating**, not a production health probe:

```sh
node scripts/check-two-owners.mjs --help
# Only after explicit authorization of a disposable deployment:
node scripts/check-two-owners.mjs --authorize-disposable-deployment
```

It writes fixed-ID fixtures, activates an extension, creates a reminder and restarts owner A. Never run it against valuable data. Successful fixture checks are not a kernel, network or cross-owner security certification.

## Restricted SSH access

`scripts/owner-gateway.mjs` can be used as a trusted SSH forced command. The fixed owner argument belongs in operator-controlled `authorized_keys`, never client input. Owners must not receive unrestricted shell/Docker-group access or permission to edit the gateway:

```text
restrict,pty,command="/ABSOLUTE/NODE24/bin/node /ABSOLUTE/pico/scripts/owner-gateway.mjs a" ssh-ed25519 OWNER_PUBLIC_KEY
```

The gateway accepts bounded chat/status/auth/RPC/backup/export/restart operations; RPC JSON travels on stdin. Do not accept client `NODE_OPTIONS`, PATH/Docker overrides, forwarding or subsystems that bypass the forced-command boundary. Review the script and SSH server policy, not just the example key line.

Prefer device-code provider login where supported. Browser OAuth callbacks may require a temporary tunnel scoped to only the intended owner's loopback ports. The two-owner example maps ChatGPT/Codex host ports 14550/14551 to container port 1455, and Google 14600/14601 respectively. Only one browser flow can bind a given local port. Container-only wildcard callback listeners must never become public native listeners; publish ports to host loopback only. [Authentication](SETUP.md#chatgptcodex-subscriptions).

## Delivery and restarts

Reminders store deterministic text and durable occurrences/outbox state; model downtime does not stop ordinary delivery. Scheduled agents are bounded read-only tasks. Ordinary restart follows each schedule's misfire policy; quiet hours and delivery caps still apply.

Pause/cancel/update stops pending or superseded work but cannot undo accepted effects. Unknown acceptance becomes **uncertain**, not successful or automatically resent. Multipart partial acceptance is uncertain; explicit retries can duplicate messages. A terminal inbox/Bot API receipt is not proof a human read it.

Use `/notifications`, current schedule state and actual operation receipts before retrying. Interrupted tool intentions are not automatically replayed; a pure interrupted stream may require another model request. Cancellation also covers preparation/retrieval, but does not undo charges.

## Upgrades

For managed native installations, see the [versioned upgrade/rollback procedure](INSTALLATION.md#upgrade-and-rollback). Installing/selecting code does not restart any owner; service restart requires closed TUI clients, idle work and explicit ephemeral-loss acknowledgment. Database downgrade is never automatic.

1. Make an application backup and protect the latest deletion ledger/credential recovery material.
2. Stop the original daemon/container gracefully when idle. A restart loses ephemeral sessions; preserve drafts/dialogs and active work.
3. Build/install the new code/image. Keep data volumes and immutable owner/instance IDs.
4. Start one daemon and inspect schema/integrity, processing, delivery and integration status before allowing further work.

Migrations preserve retained records and source lineage; a newer-than-supported database fails closed. Keep migration/compatibility regressions even when they concern old snapshots. Retired executable approvals do not become permission to execute new native code.

For the two-owner example, stop/remove only the intended containers, **never their volumes**, then rerun the launcher with the new image. Do not use the mutating checker as an upgrade health check for real owners. Container port/environment or long-lived supervisor changes require their own operator reload/recreation; `/reload` applies application settings, not code/deployment.

## Backup and restore

Use `/backup` or the CLI, not a live copy of `pico.sqlite`: WAL can contain recent transactions.

```sh
node dist/cli.js --instance PRIVATE_INSTANCE backup
```

Application backups contain an owner-bound SQLite snapshot, config/deletion history and hashed retained media/document originals/assets. Standard skill blobs and managed module artifacts are in SQLite. Credentials, IPC tokens, model weights and rebuildable indexes are excluded. Manually installed `extensions/` files and independent module-written state need separate reviewed backups; never recover them from another owner's plugins.

Restore is **offline** and requires the original to be stopped:

```sh
node dist/cli.js --instance PRIVATE_INSTANCE restore BACKUP_DIRECTORY --confirm-original-stopped
```

It verifies ownership, SQLite/foreign keys, hashes and references, applies the latest available deletion history and takes a safety snapshot before replacement. It reconstructs canonical skills, preserves disabled state and holds post-snapshot/manual skill directories in private recovery storage instead of silently enabling them.

A snapshot cannot prove what happened after it was taken. Restored pending/paused/sending deliveries become uncertain, unfinished occurrences interrupted and already-due active schedules paused for review. Sent receipts and genuinely future schedules survive. Inspect history before resuming recurring work or retrying; expired one-offs need cancellation or a new future definition.

For complete-device loss, **do not initialize a new identity over the backup**. Restore the matching latest backup's config into a private 0700 directory as 0600, create a fresh 0600 random IPC token and private attachments/artifacts/backups directories, and preserve any newer deletion ledger before offline restore. Keep the original stopped. Native recovery from container settings must restore loopback callback listeners. Reauthorize providers separately; the application backup does not contain their vault.

**If both the current database and latest deletion ledger are lost, an older external backup can contain forgotten data.** No restore can infer missing deletion history. Keep the latest ledger off-device, prefer post-forget backups and purge obsolete external copies. Provider retention, downloaded files, OS snapshots and forensic recovery remain outside managed erasure.
