#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="${PICO_DEPLOY_ROOT:-$HOME/.local/share/pico-deployment}"
APP="$(docker image inspect pico-app:0.1.0 --format '{{.Id}}')"
mkdir -p "$ROOT"; chmod 700 "$ROOT"
for NAME in pico-owner-a pico-owner-b; do
  if docker container inspect "$NAME" >/dev/null 2>&1; then echo "Container $NAME already exists; stop/remove that container to redeploy (keep its volume)." >&2; exit 1; fi
done
for OWNER in a b; do
  VOL="pico-owner-$OWNER"
  NET="pico-owner-$OWNER"
  docker volume create "$VOL" >/dev/null
  docker run --rm --user 0:0 --entrypoint /bin/sh --mount "type=volume,src=$VOL,dst=/data" "$APP" -c 'chown 1000:1000 /data; chmod 700 /data'
  if docker run --rm --mount "type=volume,src=$VOL,dst=/data" --entrypoint node "$APP" -e 'process.exit(require("node:fs").existsSync("/data/config.json")?0:1)'; then
    docker run --rm --mount "type=volume,src=$VOL,dst=/data" --entrypoint node "$APP" -e 'const c=JSON.parse(require("node:fs").readFileSync("/data/config.json")); console.log(JSON.stringify({instanceId:c.instanceId,ownerId:c.ownerId}));' >"$ROOT/owner-$OWNER-public.json"
  else
    docker run --rm --mount "type=volume,src=$VOL,dst=/data" "$APP" init --name "Owner $OWNER" >"$ROOT/owner-$OWNER-public.json"
  fi
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  if [ "$OWNER" = a ]; then CHATGPT_PORT=14550; GMAIL_PORT=14600; else CHATGPT_PORT=14551; GMAIL_PORT=14601; fi
  docker run --rm --mount "type=volume,src=$VOL,dst=/data" --entrypoint node "$APP" -e '
    const fs=require("node:fs");const p="/data/config.json";const c=JSON.parse(fs.readFileSync(p));delete c.sandbox;c.oauth={listenHost:"0.0.0.0",chatgptPort:Number(process.argv[1]),gmailPort:Number(process.argv[2])};fs.writeFileSync(p,JSON.stringify(c),{mode:0o600});' "$CHATGPT_PORT" "$GMAIL_PORT"
  docker run -d --name "pico-owner-$OWNER" --restart unless-stopped --init --read-only --network "$NET" --env PI_OAUTH_CALLBACK_HOST=0.0.0.0 -p "127.0.0.1:$CHATGPT_PORT:1455" -p "127.0.0.1:$GMAIL_PORT:$GMAIL_PORT" --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 128 --cpus 1 --memory "${PICO_OWNER_MEMORY:-8g}" --memory-swap "${PICO_OWNER_MEMORY:-8g}" --tmpfs /tmp:rw,nosuid,size=64m \
    --mount "type=volume,src=$VOL,dst=/data" "$APP" >/dev/null
  for _ in {1..100}; do docker exec "pico-owner-$OWNER" test -S /data/daemon.sock && break; sleep .1; done
  docker exec "pico-owner-$OWNER" test -S /data/daemon.sock
done
echo 'Two isolated owner containers started. Each has its own volume and authenticated private IPC.'
echo 'Trusted extensions run inside their owner daemon; no worker launcher or Docker socket is exposed.'
echo 'Daily use: docker exec -it pico-owner-a node /app/dist/cli.js --instance /data chat'
echo 'Other owner: docker exec -it pico-owner-b node /app/dist/cli.js --instance /data chat'
