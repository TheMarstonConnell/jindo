#!/usr/bin/env bash
# Shared deploy helper. Don't run directly — use deploy-sepolia.sh / deploy-mainnet.sh.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <chain-id> <rpc-url>" >&2
  exit 1
fi

CHAIN_ID="$1"
RPC="$2"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "error: $ROOT/.env not found" >&2
  echo "       cp .env.example .env  and fill it in" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY not set in .env}"

DEPLOYER="$(cast wallet address "$DEPLOYER_PRIVATE_KEY")"
BALANCE_WEI="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
BALANCE_ETH="$(cast --to-unit "$BALANCE_WEI" ether)"

echo "════════════════════════════════════════════════════════════"
echo " chain id    : $CHAIN_ID"
echo " rpc         : $RPC"
echo " deployer    : $DEPLOYER"
echo " balance     : $BALANCE_ETH ETH"
echo "════════════════════════════════════════════════════════════"

if [[ "$BALANCE_WEI" == "0" ]]; then
  echo "deployer has 0 ETH on this network — fund it first" >&2
  exit 1
fi

cd "$ROOT/contract"

VERIFY_ARGS=()
if [[ -n "${BASESCAN_API_KEY:-}" && "$BASESCAN_API_KEY" != "<https://basescan.org/myapikey>" ]]; then
  VERIFY_ARGS=(--verify --etherscan-api-key "$BASESCAN_API_KEY")
  echo "verification : enabled (basescan)"
else
  echo "verification : skipped (BASESCAN_API_KEY unset)"
fi

forge script script/Jindo.s.sol \
  --rpc-url "$RPC" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  "${VERIFY_ARGS[@]}"

BROADCAST="broadcast/Jindo.s.sol/$CHAIN_ID/run-latest.json"
if [[ ! -f "$BROADCAST" ]]; then
  echo "warning: could not locate $BROADCAST to extract address" >&2
  exit 0
fi

ADDR="$(jq -r '.transactions[] | select(.contractName == "Jindo") | .contractAddress' "$BROADCAST" | head -n1)"

echo ""
echo "════════════════════════════════════════════════════════════"
echo " deployed   : $ADDR"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Update .env:"
echo "  JINDO_CONTRACT=$ADDR"
echo "  JINDO_RPC_URL=$RPC"
