#!/usr/bin/env bash
# Runs sandbox/e2e.test.mjs against the contract WASM. Needs Linux or WSL2, and a built WASM
# (or SWARMGUILD_WASM pointing at deployment/swarmguild.wasm).
set -euo pipefail
cd "$(dirname "$0")/.."
sandbox_bin="$PWD/.tools/near-sandbox-2.13.4"
[ -x "$sandbox_bin/near-sandbox" ] || { echo 'Install NEAR Sandbox first: bash scripts/setup-near-sandbox.sh' >&2; exit 1; }
[ -d sandbox/node_modules/near-workspaces ] || { echo 'Install dependencies first: npm ci --prefix sandbox --ignore-scripts' >&2; exit 1; }
export NEAR_SANDBOX_BIN_PATH=1
export NEAR_SANDBOX_BINARY_PATH="$sandbox_bin"
cd sandbox
npm test
