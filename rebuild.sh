#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

rm -f release/ks-ssh
mkdir -p release
cargo build --release --manifest-path cli/Cargo.toml -p ks-ssh
cp -f cli/target/release/ks-ssh release/ks-ssh
echo "Built release/ks-ssh"
