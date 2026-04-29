#!/usr/bin/env bash
# Static analysis of the Jindo contract via Slither (https://github.com/crytic/slither).
# Reads contract/slither.config.json for filters and remappings.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v slither >/dev/null 2>&1; then
  cat >&2 <<EOF
error: slither not found on PATH.

install with one of:
  pipx install slither-analyzer       # recommended (isolated)
  pip3 install --user slither-analyzer

Slither also needs a system solc. Foundry ships its own; if Slither can't
locate one, install solc-select:
  pipx install solc-select
  solc-select install 0.8.34
  solc-select use 0.8.34
EOF
  exit 1
fi

cd "$ROOT/contract"

# Make sure artifacts are fresh so Slither can read them via the foundry
# integration. forge build is idempotent and fast when nothing changed.
forge build --silent

echo "════════════════════════════════════════════════════════════"
echo " slither $(slither --version 2>&1 | head -n1)"
echo " src     : src/Jindo.sol"
echo " filter  : lib/, test/, script/  (excluded)"
echo "════════════════════════════════════════════════════════════"
echo

# Run against just our source file. Slither will pull dependencies
# (forge-std interfaces) via the remappings in slither.config.json.
exec slither src/Jindo.sol "$@"
