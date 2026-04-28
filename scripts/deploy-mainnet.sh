#!/usr/bin/env bash
# Deploy Jindo to Base mainnet. Reads .env. Asks for confirmation.
set -euo pipefail

read -r -p "About to deploy to BASE MAINNET (real ETH). Type 'deploy mainnet' to confirm: " ans
if [[ "$ans" != "deploy mainnet" ]]; then
  echo "aborted." >&2
  exit 1
fi

exec "$(dirname "$0")/_deploy.sh" \
  8453 \
  "https://mainnet.base.org" \
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
