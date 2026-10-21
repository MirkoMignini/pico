# Single-owner home server

An optional Docker Compose deployment for a trusted Linux administrator running Pikobot alongside other services. Read [security](SECURITY.md), [deployment/recovery](DEPLOYMENT.md) and [verification limits](TESTING.md) first. This is an early-stage application, not a production-security certification.

## Layout and boundaries

```text
/srv/stacks/pikobot/             reviewed source, deploy/compose.yaml, deployment.env
/srv/appdata/pikobot/            private owner instance, including backups/
/etc/systemd/system/pikobot-backup.{service,timer}
```

Use a separate Compose project and data directory for each future service. Do not share Pikobot's network, credentials or data with Home Assistant or mount the Docker socket into either application. Home Assistant's discovery, USB access and host-network requirements need a separate deployment decision; it is not installed here. Do not add Kubernetes, a reverse proxy or an automatic image updater just to run this stack.

The supplied stack has a non-root UID/GID **1000:1000**, a read-only application filesystem, only one persistent host mount, dropped capabilities, no privilege escalation, bounded logs, two CPUs and a **6 GiB whole-container memory limit with no additional swap**. Its private default bridge permits outbound traffic, including access to the LAN; it is not an egress firewall or VM boundary. Skill scripts, MCP servers and generated extensions remain trusted executable code inside that owner container. Host/root administrators can access all its data. The 6 GiB limit reserves room on a 16 GiB host for other services, but is not a guarantee for large semantic document workloads; monitor and adjust deliberately if needed.

No host ports are published. Administer through SSH and `docker compose exec`; Telegram uses outbound polling. Browser OAuth callbacks are **not configured** by this minimal stack: use a supported device-code flow or API key initially. If adding browser callbacks later, use only host-loopback port publication, container-only callback binding and a narrowly scoped SSH forward as described in [deployment](DEPLOYMENT.md#restricted-ssh-access). Do not expose owner IPC, Chrome/CDP or a Docker API over the LAN/Internet.

On a rolling desktop distribution, keep OS updates deliberate, monitor disk/memory, verify lid/suspend behavior, and reserve the server's DHCP address in the router. Do not silently disable a firewall, suspend policy or disk encryption. An encrypted root disk may need a human passphrase after power loss; verify your actual boot/unlock process before promising unattended recovery. Enable services on boot, but schedule a real reboot check only when the owner approves it. An LTS server OS is a reasonable future migration, not a prerequisite or a reinstall performed by this guide.

**Check Btrfs snapshot boundaries before OS rollback.** `findmnt -T /srv/appdata/pikobot` and `findmnt -T /var/lib/docker` show their containing mounts. If both are on the root `@` subvolume, an OS snapshot rollback can also rewind owner data, credentials, deletion history and delivery receipts, bypassing Pikobot's restore safeguards. Same-disk backups there can rewind too. Before relying on OS rollbacks, plan separately mounted persistent service-data subvolumes/filesystems and account for Docker/containerd state; this guide does not modify partitioning, mounts or Docker storage. Until then, do not roll back the OS snapshot as routine service recovery: stop affected services and preserve their current data/deletion ledger off the rolled-back filesystem first.

## First deployment — new identity only

These commands are for an **empty, approved destination**, not an upgrade or migration. Never copy an existing live instance or credentials into this checkout. Docker Engine, Compose and systemd must already be installed. Keep Docker sudo-only; Docker-group membership would grant root-equivalent access.

1. Put an inspected source-only snapshot at `/srv/stacks/pikobot`, owned by the administrator/root rather than writable by a container. Exclude `.git`, `.instances`, credentials, `node_modules` and `dist`. Preserve its exact revision/checksum outside the owner directory. The container builds with the Node/pnpm versions pinned in `deploy/Dockerfile`; the host's Node version is not used.
2. Create the owner directory **only if it does not already exist**:

   ```sh
   test ! -e /srv/appdata/pikobot || { echo 'Existing data: stop and plan migration'; exit 1; }
   sudo install -d -m 0755 /srv/appdata
   sudo install -d -m 0700 -o 1000 -g 1000 /srv/appdata/pikobot
   ```

   On hosts where UID 1000 belongs to an unrelated person, choose a reviewed matching container/data UID instead. Directory permissions are not isolation from that host user.
3. Create `/srv/stacks/pikobot/deployment.env` with a **unique, reviewed image tag**, not `latest`, for example `PIKOBOT_IMAGE=pikobot-app:git-REVISION-SNAPSHOT_HASH`. This file contains no secrets. Never rebuild a deployed tag with different source; record the resulting image ID too.
4. Enable Docker and define a convenience function in your current operator shell:

   ```sh
   sudo systemctl enable --now docker.service
   piko() {
     sudo docker compose --env-file /srv/stacks/pikobot/deployment.env \
       -f /srv/stacks/pikobot/deploy/compose.yaml "$@"
   }
   piko config --quiet
   piko build --pull
   piko run --rm --no-deps pikobot init --name 'Your name'
   piko up -d --no-build
   piko ps
   piko exec -T pikobot node /app/dist/cli.js --instance /data readiness
   ```

   Initialization is performed **once**, before the service starts. A failed or interrupted build/start is not permission to repeat initialization or delete owner data. Inspect actual state first. `restart: unless-stopped` starts an existing, non-stopped container when Docker starts; an explicitly stopped container stays stopped. Health is authenticated local IPC readiness, not successful authentication, inference or Telegram delivery. Docker does not restart a container just because a healthcheck fails.
5. Enter credentials yourself through the masked terminal dialogs:

   ```sh
   piko exec -it pikobot node /app/dist/cli.js --instance /data chat
   ```

   Open `/setup`, choose your model/account, embeddings and timezone, then `/channels telegram setup` if wanted. Defaults are DeepSeek chat/extraction and hosted OpenAI embeddings, which can incur charges. Do not send keys in chat, shell arguments, `deployment.env` or this repository. No provider/Telegram credentials are imported or tested by deployment. Every Telegram allowlisted ID has owner authority; only add your own private numeric ID. See [setup](SETUP.md).

   `/readiness` and `/doctor` are non-inference diagnostics. A fresh unconfigured instance is expected to fail doctor's model-credential check even while its daemon is healthy. Explicit model tests can charge; Telegram `/start` or `/help` needs no inference. Separately verify a synthetic chat, Telegram reply and reminder when ready; process startup alone proves none of them.

## Local backups

Pikobot's application backup uses SQLite's backup API and retains originals/config/deletion history, with **14-day retention by default**. Do not copy the live SQLite file or WAL. Install the supplied timer only after first deployment:

```sh
sudo install -m 0644 /srv/stacks/pikobot/deploy/pikobot-backup.service /etc/systemd/system/
sudo install -m 0644 /srv/stacks/pikobot/deploy/pikobot-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pikobot-backup.timer
piko exec -T pikobot node /app/dist/cli.js --instance /data backup
systemctl list-timers pikobot-backup.timer
```

The timer runs at 04:15 host-local time plus up to 15 minutes of jitter, and catches up missed runs after downtime. It uses the authenticated client's backup RPC directly, without the CLI's daemon-start fallback; missing container/IPC fails rather than starting a replacement or retrying immediately. Backup stdout is discarded to avoid retaining owner-bound manifests in the system journal; failures still make the unit fail. Check `systemctl status pikobot-backup.service` and backup dates/size privately. A timeout is uncertain: inspect before running another backup. There is no alerting or disk quota here; 14 full copies of a large document archive can exhaust a small disk.

**These copies are on the same disk, not disaster recovery.** Choose an encrypted off-device destination before relying on important data. Keep the latest deletion ledger off-device and retire obsolete external copies after forgetting. Application backups exclude credentials, manually installed extensions, independent extension state and rebuildable caches. Plan separate encrypted credential recovery or provider reauthorization. No NAS/cloud credentials or external destination are assumed. Follow the identity-preserving [offline restore procedure](DEPLOYMENT.md#backup-and-restore); never initialize a new owner over a backup. A successful backup is not a tested restore.

## Maintenance and updates

Use `piko ps`, bounded private logs (`piko logs --tail 100 pikobot`), `/doctor`, disk usage and timer status. Log contents and detailed status are private. Do not install Pikobot's native `service` supervision inside the container; Docker already supervises it. Do not run the mutating two-owner deployment checker against this instance.

OS shutdown and direct Docker stop/recreation bypass Pikobot's idle/draft guards. For planned upgrades:

1. Preserve drafts, finish work/deliveries/sign-ins, close **all** TUI clients, create a backup and retain the current image/config/source and deletion ledger. A restart loses ephemeral sessions.
2. Prepare and check a new source snapshot with a new image tag; build it without replacing the running daemon. Never run `init` again. Keep `/srv/appdata/pikobot` in place.
3. Disable automatic restarts for the current container before using the authenticated stop guard:

   ```sh
   container="$(piko ps -q pikobot)"
   sudo docker update --restart=no "$container"
   piko exec -T pikobot node /app/dist/cli.js --instance /data \
     rpc daemon.stop '{"confirmEphemeral":true}'
   ```

   The guard refuses active work or open clients; do not force it. The CLI runs inside the container and can be terminated with the daemon before returning, so a nonzero `exec` exit alone does **not** prove refusal. Without replaying the stop, inspect the saved container ID:

   ```sh
   sudo docker inspect --format \
     'status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restart={{.HostConfig.RestartPolicy.Name}}' \
     "$container"
   ```

   Confirm `exited`, `running=false`, exit code `0`, `oom=false` and restart policy `no`, with no live IPC daemon, before proceeding. Other states need private inspection, not another stop or forced recreation. On a definite RPC refusal, restore `--restart=unless-stopped` for that same container and arrange another idle maintenance window. A lost acknowledgment is uncertain: inspect the container/IPC/logs before retrying. Do not disable restarts and then leave the running instance unattended.
4. After confirmed graceful shutdown, select the new image in `deployment.env`, then run `piko up -d --no-build --force-recreate`. Recreation is intentional **only now that the daemon is stopped**; it restores the Compose restart policy. Keep the data directory and old image. Check the actual image ID, health, `/doctor`, retained records and delivery state. Do not restart Docker or unrelated stacks to upgrade Pikobot.

Source snapshot transfer, image build and source/unit-file replacement require a separately reviewed operator procedure; this guide does not automate upgrades. Newer database schemas may reject old code: selecting an old image is not a database rollback. See [upgrade/recovery](DEPLOYMENT.md#upgrades). A host reboot, real restore, resource/load test, external backup, live provider access and real Telegram delivery are separate acceptance checks, not established by the supplied configuration or fixture tests.
