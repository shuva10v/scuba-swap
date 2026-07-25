#!/usr/bin/env bash
# Stands up the ScubaSwap demo chain: an anvil fork of World Chain with Aqua,
# our router, and all three programs shipped and quotable.
#
#   ./script/demo-up.sh          start fresh
#   ./script/demo-up.sh --keep   reuse a running anvil
#
# Why a fork rather than a testnet: World Chain carries the World ID v4 verifier
# but no Aqua, so Aqua has to be deployed either way (FRICTION W-07). Forking
# keeps the verifier real — the frontend reads genuine quotes and, with a
# staging proof, genuinely verifies.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${WORLDCHAIN_RPC_URL:-https://worldchain.drpc.org}"
PORT="${ANVIL_PORT:-8545}"
LOCAL="http://127.0.0.1:${PORT}"
# Fork at LATEST, not a pinned block.
#
# A World ID v4 proof carries its Merkle root as a public input, and the verifier
# only accepts roots inside its ~1 hour history window. A pinned fork freezes that
# history, so a freshly minted proof reverts InvalidMerkleRoot() — and because
# JumpIfHumanTaker falls through on any failure, the human tier silently quotes the
# open price with no error anywhere. Forking at latest keeps the identity tree
# current, and also keeps block.timestamp near wall-clock so the guard's freshness
# check means something.
#
# Test suites stay pinned deliberately (reproducibility + RPC caching); only the
# live demo needs to track the chain.
BLOCK="${FORK_BLOCK:-latest}"

WETH=0x4200000000000000000000000000000000000006
USDC=0x79A02482A880bCE3F13e09Da970dC34db4CD24d1

# anvil's first default account — deterministic, so the frontend can hardcode it.
MAKER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
MAKER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TAKER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [[ "${1:-}" != "--keep" ]]; then
  pkill -f "anvil.*--port ${PORT}" 2>/dev/null || true
  sleep 0.5
  log "forking World Chain @ ${BLOCK} on :${PORT}"
  if [[ "$BLOCK" == "latest" ]]; then
    anvil --fork-url "$RPC" --port "$PORT" --silent --chain-id 480 &
  else
    anvil --fork-url "$RPC" --fork-block-number "$BLOCK" --port "$PORT" --silent --chain-id 480 &
  fi
  for _ in $(seq 1 40); do
    cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1 || die "anvil is not up on ${LOCAL}"
log "anvil up, block $(cast block-number --rpc-url "$LOCAL")"

# ---------------------------------------------------------------------------
# Funding.
#
# Foundry's `deal` is a test-only cheatcode: inside a script it mutates the
# local simulation, never the node. So balances are written straight into
# anvil's state over RPC.
#
# The balances mapping slot is discovered rather than hardcoded — USDC is a
# proxy and its layout is not something to guess. We try candidates and keep
# the one that actually moves `balanceOf`, then verify. A wrong guess that
# silently did nothing would surface much later as an opaque revert inside
# `ship`.
# ---------------------------------------------------------------------------
fund_erc20() {
  local token=$1 holder=$2 amount=$3 label=$4 slot found="" key
  # A SENTINEL is written first, not the target amount. Checking
  # `balanceOf == amount` directly gives false positives: if the account already
  # holds that amount from a previous run, the very first candidate slot
  # "succeeds" without having changed anything — and we then write garbage into
  # slot 0 of a real token proxy. The sentinel is a value nothing would hold by
  # coincidence, so a match proves we found the right slot.
  local sentinel=0x000000000000000000000000000000000000000000000000000000000badc0de
  for slot in 0 1 2 3 4 5 6 7 8 9 10 11; do
    key=$(cast index address "$holder" "$slot")
    local before
    before=$(cast storage "$token" "$key" --rpc-url "$LOCAL")
    cast rpc anvil_setStorageAt "$token" "$key" "$sentinel" --rpc-url "$LOCAL" >/dev/null
    if [[ "$(cast call "$token" "balanceOf(address)(uint256)" "$holder" --rpc-url "$LOCAL" | awk '{print $1}')" == "195936478" ]]; then
      found=$slot
    fi
    # Always restore, whether or not this was the slot.
    cast rpc anvil_setStorageAt "$token" "$key" "$before" --rpc-url "$LOCAL" >/dev/null
    [[ -n "$found" ]] && break
  done
  [[ -n "$found" ]] || die "could not locate balance slot for ${label} (${token})"

  key=$(cast index address "$holder" "$found")
  cast rpc anvil_setStorageAt "$token" "$key" "$(cast to-uint256 "$amount")" --rpc-url "$LOCAL" >/dev/null
  local got
  got=$(cast call "$token" "balanceOf(address)(uint256)" "$holder" --rpc-url "$LOCAL" | awk '{print $1}')
  [[ "$got" == "$amount" ]] || die "${label}: wrote slot ${found} but balanceOf is ${got}, expected ${amount}"
  log "funded ${label} ${holder:0:10}… (balances slot ${found})"
}

log "funding maker and taker"
cast rpc anvil_setBalance "$MAKER" "$(cast to-uint256 $((100 * 10**18)))" --rpc-url "$LOCAL" >/dev/null
cast rpc anvil_setBalance "$TAKER" "$(cast to-uint256 $((100 * 10**18)))" --rpc-url "$LOCAL" >/dev/null

fund_erc20 "$WETH" "$MAKER" 1000000000000000000000    "maker WETH"   # 1000
fund_erc20 "$USDC" "$MAKER" 4000000000000             "maker USDC"   # 4,000,000
fund_erc20 "$WETH" "$TAKER" 100000000000000000000     "taker WETH"   # 100
fund_erc20 "$USDC" "$TAKER" 100000000000              "taker USDC"   # 100,000

# ---------------------------------------------------------------------------
# Deploy with `forge create`, ship with `forge script`.
#
# The CREATEs cannot go through forge script: it fails to locate constructor
# arguments inside via_ir init code and aborts with
# `type check failed for "offset (usize)"` — after the script body has already
# written demo.json, so the config named a router that was never deployed and every
# downstream failure looked like a contract bug. via_ir is mandatory (SwapVM is
# "stack too deep" without it), so the CREATEs move out here and the script is left
# broadcasting only CALLs, which decode correctly.
# ---------------------------------------------------------------------------
ACTION_PREFIX="${WORLD_ID_ACTION_PREFIX:-scubaswap}"
VERIFIER="${WORLD_ID_VERIFIER:-0x703a6316c975DEabF30b637c155edD53e24657DB}"
RP_ID_NUM="${WORLD_ID_RP_ID:-15578405237850119539}"

create() { # <path:Name> [ctor args...]
  local target=$1; shift
  forge create "$target" --rpc-url "$LOCAL" --private-key "$MAKER_PK" --broadcast \
    ${1+--constructor-args} "$@" 2>&1 | grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" | awk '{print $3}'
}

log "deploying Aqua"
AQUA=$(create node_modules/@1inch/aqua/src/Aqua.sol:Aqua)
[[ -n "$AQUA" ]] || die "Aqua deployment failed"

log "deploying ScubaSwapVMRouter (action prefix=${ACTION_PREFIX}-*)"
ROUTER=$(create src/routers/ScubaSwapVMRouter.sol:ScubaSwapVMRouter \
  "$AQUA" "$WETH" "$MAKER" "ScubaSwapVM" "1" "$VERIFIER" "$ACTION_PREFIX" "$RP_ID_NUM")
[[ -n "$ROUTER" ]] || die "router deployment failed"

for c in "$AQUA" "$ROUTER"; do
  [[ "$(cast code "$c" --rpc-url "$LOCAL" | wc -c)" -gt 100 ]] || die "no code at ${c}"
done
log "aqua ${AQUA}"
log "router ${ROUTER}"

# MakerTraits requires tokenA < tokenB. On World Chain WETH (0x4200..06) sorts
# before USDC (0x79A0..), the opposite of Ethereum — so sort rather than assume.
# `${x,,}` is bash 4+; macOS ships 3.2, so lowercase with tr.
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
if [[ "$(lower "$WETH")" < "$(lower "$USDC")" ]]; then
  T_A="$WETH"; T_B="$USDC"; S_A=100000000000000000000; S_B=400000000000
else
  T_A="$USDC"; T_B="$WETH"; S_A=400000000000; S_B=100000000000000000000
fi

EXISTING_FAUCET=""

log "shipping programs"
TOKEN_A="$T_A" TOKEN_B="$T_B" SHIP_A="$S_A" SHIP_B="$S_B" \
AQUA_ADDRESS="$AQUA" ROUTER_ADDRESS="$ROUTER" DEPLOYMENT_RPC_URL="$LOCAL" DEPLOYMENT_FAUCET="$EXISTING_FAUCET" \
WORLD_ID_ACTION_PREFIX="$ACTION_PREFIX" WORLD_ID_VERIFIER="$VERIFIER" WORLD_ID_RP_ID="$RP_ID_NUM" \
forge script script/DeployDemo.s.sol --rpc-url "$LOCAL" --broadcast \
  --private-key "$MAKER_PK" >/dev/null 2>&1 || {
    TOKEN_A="$T_A" TOKEN_B="$T_B" SHIP_A="$S_A" SHIP_B="$S_B" \
    AQUA_ADDRESS="$AQUA" ROUTER_ADDRESS="$ROUTER" DEPLOYMENT_RPC_URL="$LOCAL" DEPLOYMENT_FAUCET="$EXISTING_FAUCET" \
    WORLD_ID_ACTION_PREFIX="$ACTION_PREFIX" WORLD_ID_VERIFIER="$VERIFIER" WORLD_ID_RP_ID="$RP_ID_NUM" \
    forge script script/DeployDemo.s.sol --rpc-url "$LOCAL" --broadcast --private-key "$MAKER_PK"
    die "shipping failed"
  }

[[ -f deployments/demo.json ]] || die "deployments/demo.json was not written"

# Assert the recorded router actually EXISTS before declaring success.
#
# The script writes demo.json during simulation, where `new Router()` returns an
# address derived from the simulated nonce. Deploying repeatedly onto persisted
# anvil state can drift that from the broadcast nonce, so the file ends up naming
# an address with no code — and every downstream failure then looks like a
# contract bug rather than a stale config. Checking here keeps that honest.
ROUTER=$(python3 -c "import json;print(json.load(open('deployments/demo.json'))['router'])")
CODE=$(cast code "$ROUTER" --rpc-url "$LOCAL" 2>/dev/null)
if [[ "${#CODE}" -lt 100 ]]; then
  die "demo.json names router ${ROUTER}, which has no code. Simulation and broadcast
     addresses diverged — restart anvil clean (drop --keep) so nonces are deterministic."
fi

log "router ${ROUTER}"

# Smoke test: real quotes against the shipped programs, using the SAME encoder
# the frontend uses. If these return zero the demo is broken, and the frontend
# would show empty panels with no explanation.
log "verifying live quotes via the SDK encoder"
node script/smoke-quote.mjs "$LOCAL" || die "smoke test failed"

echo
log "demo chain ready"
echo "   RPC      ${LOCAL}   (chainId 480)"
echo "   router   ${ROUTER}"
echo "   maker    ${MAKER}"
echo "   taker    ${TAKER}  (import this key into your wallet)"
echo "   config   deployments/demo.json"
