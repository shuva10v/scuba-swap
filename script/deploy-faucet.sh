#!/usr/bin/env bash
#
# Deploy the dWETH faucet against an existing deployment and record it in the config.
#
#   ./script/deploy-faucet.sh            DRY RUN — prints the plan, sends nothing
#   ./script/deploy-faucet.sh --execute  deploys and patches deployments/
#
# Standalone rather than folded into deploy-worldchain.sh, because that script always
# creates new routers: adding the faucet through it would orphan the routers already live
# and shipped. The faucet is additive — it fronts the token that is already deployed and
# needs no new liquidity, no re-ship, and no router change.
#
# Optional:
#   WORLDCHAIN_RPC_URL   defaults to the public drpc endpoint
#   CLAIM_AMOUNT         whole tokens per claim (default 1)
#   CLAIM_COOLDOWN       seconds between claims (default 3600)
#
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${WORLDCHAIN_RPC_URL:-https://worldchain.drpc.org}"
AMOUNT_WHOLE="${CLAIM_AMOUNT:-1}"
COOLDOWN="${CLAIM_COOLDOWN:-3600}"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

EXECUTE=0
[[ "${1:-}" == "--execute" ]] && EXECUTE=1

log "preflight"
command -v forge >/dev/null || die "forge not found"
[[ -n "${DEPLOYER_PK:-}" ]] || die "DEPLOYER_PK is not set"
[[ -f deployments/worldchain.json ]] || die "deployments/worldchain.json is missing — deploy the chain side first"

CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "cannot reach ${RPC}"
[[ "$CHAIN" == "480" ]] || die "expected World Chain (480), got chain ${CHAIN}"

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK") || die "DEPLOYER_PK is not a valid key"

# The faucet fronts the base (18dp) token — the one a visitor needs before they can trade
# at all. The quote side is reachable by swapping, so one faucet is enough.
TOKEN=$(python3 -c "import json;print(json.load(open('deployments/worldchain.json'))['weth'])")
SYMBOL=$(python3 -c "import json;print(json.load(open('deployments/worldchain.json')).get('baseSymbol','?'))")
DECIMALS=$(python3 -c "import json;print(json.load(open('deployments/worldchain.json'))['baseDecimals'])")
[[ "$(cast code "$TOKEN" --rpc-url "$RPC" | wc -c)" -gt 100 ]] || die "no code at token ${TOKEN}"

# Confirm on chain rather than trusting the config, and confirm the token really is
# mintable — the faucet mints on demand, so a non-mintable token would deploy fine and
# fail on every claim.
ONCHAIN_DEC=$(cast call "$TOKEN" 'decimals()(uint8)' --rpc-url "$RPC" | awk '{print $1}')
[[ "$ONCHAIN_DEC" == "$DECIMALS" ]] || die "token reports ${ONCHAIN_DEC}dp, config says ${DECIMALS}dp"
cast call "$TOKEN" 'mint(address,uint256)' "$DEPLOYER" 0 --rpc-url "$RPC" >/dev/null 2>&1 \
  || die "token ${TOKEN} does not expose a permissionless mint(address,uint256)"

AMOUNT=$(python3 -c "print($AMOUNT_WHOLE * 10**$DECIMALS)")
EXISTING=$(python3 -c "import json;print(json.load(open('deployments/worldchain.json')).get('faucet') or '')")

cat <<PLAN

  ┌─ dWETH faucet → World Chain mainnet ──────────────────────────────
  │ rpc            ${RPC}
  │ deployer       ${DEPLOYER}
  │ balance        $(cast to-unit "$(cast balance "$DEPLOYER" --rpc-url "$RPC")" ether) ETH
  │
  │ token          ${TOKEN}  (${SYMBOL}, ${DECIMALS}dp)
  │ per claim      ${AMOUNT_WHOLE} ${SYMBOL}  (${AMOUNT} base units)
  │ cooldown       ${COOLDOWN}s
  │ existing       ${EXISTING:-<none — this will be the first>}
  └───────────────────────────────────────────────────────────────────

PLAN

warn "The cooldown is a fairness guard, not a supply limit: DemoToken.mint is"
warn "permissionless by design, so anyone can bypass the faucet entirely."

if [[ $EXECUTE -eq 0 ]]; then
  log "DRY RUN — nothing was sent. Re-run with --execute to deploy."
  exit 0
fi

[[ -z "$EXISTING" ]] || warn "replacing the faucet already recorded at ${EXISTING}"

log "deploying DemoFaucet"
FAUCET=$(forge create src/demo/DemoFaucet.sol:DemoFaucet --rpc-url "$RPC" \
  --private-key "$DEPLOYER_PK" --broadcast \
  --constructor-args "$TOKEN" "$AMOUNT" "$COOLDOWN" 2>&1 \
  | grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" | awk '{print $3}')
[[ -n "$FAUCET" ]] || die "faucet deployment failed"
[[ "$(cast code "$FAUCET" --rpc-url "$RPC" | wc -c)" -gt 100 ]] || die "no code at ${FAUCET}"
log "faucet ${FAUCET}"

# Read the immutables back from the chain instead of trusting the constructor args.
OC_TOKEN=$(cast call "$FAUCET" 'TOKEN()(address)' --rpc-url "$RPC" | awk '{print $1}')
OC_AMOUNT=$(cast call "$FAUCET" 'AMOUNT()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
OC_COOL=$(cast call "$FAUCET" 'COOLDOWN()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
[[ "$(lower "$OC_TOKEN")" == "$(lower "$TOKEN")" ]] || die "faucet token is ${OC_TOKEN}, expected ${TOKEN}"
[[ "$OC_AMOUNT" == "$AMOUNT" ]] || die "faucet amount is ${OC_AMOUNT}, expected ${AMOUNT}"
[[ "$OC_COOL" == "$COOLDOWN" ]] || die "faucet cooldown is ${OC_COOL}, expected ${COOLDOWN}"
log "config verified on-chain"

# Prove it works before recording it, rather than finding out from a visitor.
log "smoke-testing a claim"
BEFORE=$(cast call "$TOKEN" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')
cast send "$FAUCET" 'claim()' --rpc-url "$RPC" --private-key "$DEPLOYER_PK" >/dev/null \
  || die "claim() reverted"
AFTER=$(cast call "$TOKEN" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')
[[ "$(python3 -c "print(1 if $AFTER - $BEFORE == $AMOUNT else 0)")" == "1" ]] \
  || die "claim moved $(python3 -c "print($AFTER - $BEFORE)") units, expected ${AMOUNT}"
WAIT=$(cast call "$FAUCET" "waitFor(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')
log "claim delivered ${AMOUNT_WHOLE} ${SYMBOL}; cooldown now reports ${WAIT}s"

log "recording in deployments/"
python3 - "$FAUCET" <<'PY'
import json, glob, sys
faucet = sys.argv[1]
for f in glob.glob("deployments/worldchain-*.json"):
    d = json.load(open(f)); d["faucet"] = faucet
    json.dump(d, open(f, "w"), indent=2, sort_keys=True)
    print(f"  {f}")
PY
ARGS=()
for f in deployments/worldchain-*.json; do
  n=${f##*/worldchain-}; n=${n%.json}
  ARGS+=("${n}=${f}")
done
node script/merge-deployments.mjs deployments/worldchain.json "${ARGS[@]}" >/dev/null \
  || die "merging deployment configs failed"

cat <<DONE

$(log "faucet deployed")
   faucet      ${FAUCET}
   token       ${TOKEN}  (${SYMBOL})
   per claim   ${AMOUNT_WHOLE} ${SYMBOL} / ${COOLDOWN}s per address

   Point the frontend at it and publish:
     cp deployments/worldchain.json deployments/demo.json
     ./script/deploy-frontend.sh --execute
DONE
