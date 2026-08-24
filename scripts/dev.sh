#!/usr/bin/env bash
# Dev runner: vite dev server (frontend) + go run (backend) with proxy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

(cd "$ROOT/apps/web" && [ -d node_modules ] || npm install)
(cd "$ROOT/apps/web" && npm run dev) &
WEB_PID=$!
trap 'kill $WEB_PID 2>/dev/null || true' EXIT

cd "$ROOT/apps/server"
PORT="${PORT:-8090}" DATA_DIR="${DATA_DIR:-$ROOT/data}" SECRET_KEY="${SECRET_KEY:-change_me}" \
  go run ./cmd/ks-ssh
