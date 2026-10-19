#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
# Herdr uses this shell for every space; unrelated panes must keep their own directory.
if [[ "${1:-pane}" == pane && -z "${PIKOBOT_DEV_ROLE:-}" && "$(pwd -P)" != "$repo" ]]; then
  exec "${SHELL:-/bin/bash}" -i
fi
cd "$repo"

if [[ "$(node --version 2>/dev/null || true)" != v24.21.0 ]]; then
  for bin in /opt/homebrew/opt/node@24/bin /usr/local/opt/node@24/bin "$HOME/.local/share/mise/installs/node/24.21.0/bin"; do
    if [[ -x "$bin/node" && "$("$bin/node" --version)" == v24.21.0 ]]; then
      export PATH="$bin:$PATH"
      break
    fi
  done
fi
[[ "$(node --version)" == v24.21.0 ]] || { echo 'Select Node 24.21.0 first (see .node-version).' >&2; exit 1; }
[[ "$(pnpm --version)" == 11.2.2 ]] || { echo 'Use pnpm 11.2.2.' >&2; exit 1; }
if [[ $# == 0 ]]; then set -- pane; fi
if [[ "$1" == pane ]]; then
  node scripts/dev.mjs pane || echo 'Development command stopped; inspect its output before restarting.' >&2
  exec "${SHELL:-/bin/bash}" -i
fi
exec node scripts/dev.mjs "$@"
