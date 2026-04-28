#!/usr/bin/env bash
# Deploy Jindo to Base Sepolia. Reads .env.
set -euo pipefail
exec "$(dirname "$0")/_deploy.sh" \
  84532 \
  "https://sepolia.base.org" \
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
