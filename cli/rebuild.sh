#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 1. Frontend (React + TS, cf style)
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install --progress=false)
fi
(cd frontend && npm run build)

# 2. Backend (Rust, embeds frontend/dist)
rm -f release/ks-ssh
mkdir -p release
cargo build --release -p ks-ssh
cp -f target/release/ks-ssh release/ks-ssh
echo "Built release/ks-ssh — run: ./release/ks-ssh --port 8080"
