#!/usr/bin/env bash
#
# Deploy ScubaSwap to World Chain mainnet (chain 480).
#
#   ./script/deploy-worldchain.sh            DRY RUN — prints the plan, sends nothing
#   ./script/deploy-worldchain.sh --execute  actually deploys
#
# Why deploy for real: World Chain is where the World ID v4 verifier lives, and an
# anvil fork freezes the identity tree at the fork block. A proof minted after that
# point carries a Merkle root the fork has never seen, so verification fails and
# JumpIfHumanTaker silently prices at the open tier. On the live chain the tree is
# never stale and that whole class of problem disappears.
#
# Why demo tokens: shipping liquidity requires granting Aqua an ERC20 allowance,
# and an allowance is only as dangerous as the token behind it. These are worthless
# and freely mintable, so a first live deployment risks nothing. Do NOT grant this
# Aqua an allowance on any token you care about.
#
# Requirements:
#   DEPLOYER_PK   private key, funded with a small amount of ETH on World Chain
#                 (~0.002 ETH is ample; the router is the only large deployment)
#
# Optional:
#   WORLDCHAIN_RPC_URL   defaults to the public drpc endpoint
#   WORLD_ID_ACTION_PREFIX  required prefix of the action; defaults to "scubaswap".
#                        The router commits to the PREFIX, not to one exact action,
#                        because World ID issues at most one proof per
#                        (identity, rp, action). Pinning one action gave each human
#                        a single gear-up per deployment. Takers now name
#                        "<prefix>-<timestamp>" and can dive repeatedly.
#   WORLD_ID_RP_ID       numeric rp id; defaults to rp_d8319d06a1241d73
#   DWETH, DUSDC         reuse existing demo tokens instead of deploying new ones
#   AQUA_ADDRESS         reuse an existing Aqua
#                        All three are optional. Pass them to add a router to a
#                        deployment that already exists — otherwise every run creates
#                        a fresh set and orphans the previous one, including any demo
#                        tokens people have already minted to trade with.
#   WORLD_ID_ENV         both | production | staging   (default both)
#                        `both` deploys one router per World ID environment, sharing
#                        Aqua and the demo tokens. The verifier is a router immutable
#                        and staging/production are separate identity trees, so one
#                        router cannot serve both — and the frontend toggle needs one
#                        of each to switch between the real World App and the simulator.
#
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${WORLDCHAIN_RPC_URL:-https://worldchain.drpc.org}"
ACTION_PREFIX="${WORLD_ID_ACTION_PREFIX:-scubaswap}"
RP_ID_NUM="${WORLD_ID_RP_ID:-15578405237850119539}"
WID_ENV="${WORLD_ID_ENV:-both}"

# Addresses to reuse instead of deploying. Set these to add a router to an existing
# deployment, or to retry without orphaning what already landed.
DWETH_REUSE="${DWETH:-}"
DUSDC_REUSE="${DUSDC:-}"
AQUA_REUSE="${AQUA_ADDRESS:-}"

# World Chain predeploy. Only used for SwapVM's WETH-unwrap support — never as
# part of the traded pair, so no real WETH is involved anywhere.
WETH=0x4200000000000000000000000000000000000006

VERIFIER_PRODUCTION=0x00000000009E00F9FE82CfeeBB4556686da094d7
VERIFIER_STAGING=0x703a6316c975DEabF30b637c155edD53e24657DB

# Shipped liquidity, in demo tokens. Deep enough that a 10-token swap barely moves
# the curve, so the tier difference on stage is the fee and not slippage.
# Ratio, not just depth: the pair has to read like the WETH/USDC it imitates, so
# ~4,000 dUSDC per dWETH. (First draft shipped 4,000 dUSDC against 1,000 dWETH —
# deep enough, but a price of 4 USDC/ETH, which makes the stage demo look broken.)
SHIP_WETHLIKE=1000000000000000000000   # 1,000 dWETH (18dp)
SHIP_USDCLIKE=4000000000000            # 4,000,000 dUSDC (6dp) -> ~4,000 per dWETH
# 3x the ship amount: each router gets its own Aqua balance (the order hash commits
# to the router), so two routers ship twice, and the surplus leaves the deployer
# something to trade with without minting again.
MINT_WETHLIKE=3000000000000000000000
MINT_USDCLIKE=12000000000000

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

EXECUTE=0
[[ "${1:-}" == "--execute" ]] && EXECUTE=1

# `both` is the default: a router serves exactly one identity tree (the verifier is
# immutable), so testing production and staging flows without redeploying means
# having one of each. Aqua and the demo tokens are shared, so the second router costs
# only its own deploy plus its own ship.
case "$WID_ENV" in
  both)       VERIFIERS_WANTED="$VERIFIER_PRODUCTION $VERIFIER_STAGING" ;;
  production) VERIFIERS_WANTED="$VERIFIER_PRODUCTION" ;;
  staging)    VERIFIERS_WANTED="$VERIFIER_STAGING" ;;
  *) die "WORLD_ID_ENV must be both, production or staging, got '${WID_ENV}'" ;;
esac

# `${x,,}` is bash 4+ and macOS ships 3.2. Defined up here because the preflight and
# the deploy both compare addresses case-insensitively.
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

# ---------------------------------------------------------------- preflight
log "preflight"

command -v forge >/dev/null || die "forge not found"
[[ -n "${DEPLOYER_PK:-}" ]] || die "DEPLOYER_PK is not set"

CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "cannot reach ${RPC}"
[[ "$CHAIN" == "480" ]] || die "expected World Chain (480), got chain ${CHAIN}"

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK") || die "DEPLOYER_PK is not a valid key"
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
BAL_ETH=$(cast to-unit "$BAL" ether)

# The verifiers are the one thing we do not deploy, so a wrong address here would
# only surface as an unexplained revert much later.
for v in $VERIFIERS_WANTED; do
  [[ "$(cast code "$v" --rpc-url "$RPC" | wc -c)" -gt 100 ]] \
    || die "no code at verifier ${v} — wrong chain?"
done

# Plain keccak256 of the prefix — NOT hashToField. The guard compares the prefix by
# keccak and only reduces the *full* action to a field element (W-05 applies to the
# action, not to this commitment).
PREFIX_HASH=$(cast keccak "$(cast from-utf8 "$ACTION_PREFIX")")

cat <<PLAN

  ┌─ ScubaSwap → World Chain mainnet ─────────────────────────────────
  │ rpc            ${RPC}
  │ chain          ${CHAIN}
  │ deployer       ${DEPLOYER}
  │ balance        ${BAL_ETH} ETH
  │
  │ World ID env   ${WID_ENV}
  │ verifiers      $(echo $VERIFIERS_WANTED | tr ' ' '\n' | sed '2,$s/^/                  /')
  │ action prefix  ${ACTION_PREFIX}-*      ← takers append their own suffix
  │   keccak256    ${PREFIX_HASH}
  │ rp id          ${RP_ID_NUM}
  │
  │ dWETH          ${DWETH_REUSE:-<new DemoToken, 18dp, worthless, freely mintable>}
  │ dUSDC          ${DUSDC_REUSE:-<new DemoToken, 6dp>}
  │ aqua           ${AQUA_REUSE:-<new Aqua — World Chain has none (W-07)>}
  │ will deploy    one ScubaSwapVMRouter per env above (always new)
  │ will ship      programs A (open) / B (tiered) / C (human-only)
  │                on ONE balance per router
  └───────────────────────────────────────────────────────────────────

PLAN

# A balance check is cheap and a failed mid-deploy is not: the router deploy is
# large, and running out of gas after Aqua lands leaves a half-built system.
MIN_WEI=1000000000000000   # 0.001 ETH
if [[ "$(python3 -c "print(1 if $BAL < $MIN_WEI else 0)")" == "1" ]]; then
  die "deployer balance is ${BAL_ETH} ETH; fund it with at least 0.002 ETH for gas"
fi

case "$WID_ENV" in
  both|production)
    warn "The production router needs a Developer Portal app that exists in production,"
    warn "and proofs from a real Orb-verified World App. The simulator issues STAGING"
    warn "proofs — use the staging router for those. The frontend toggle picks which." ;;
esac

if [[ $EXECUTE -eq 0 ]]; then
  echo
  log "DRY RUN — nothing was sent. Re-run with --execute to deploy."
  exit 0
fi

echo
read -r -p "Type 'deploy' to send these transactions: " CONFIRM
[[ "$CONFIRM" == "deploy" ]] || die "aborted"

# ---------------------------------------------------------------- deploy
# `forge create`, not `forge script`, for every CREATE. forge script cannot locate
# constructor arguments inside via_ir init code and aborts with
# `type check failed for "offset (usize)"` — after the script body has run, so it
# can leave a config file naming a contract that was never deployed. via_ir is
# mandatory (SwapVM is "stack too deep" without it).
create() {
  local target=$1; shift
  forge create "$target" --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast \
    ${1+--constructor-args} "$@" 2>&1 | grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" | awk '{print $3}'
}

send() { cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" "$@" >/dev/null; }

# Reuse anything already on chain. Without this, every re-run mints a whole new
# world: new tokens, new Aqua, new routers — so adding a staging router later, or
# retrying after one leg failed, would orphan the first deployment and change every
# address the frontend points at. The tokens especially are worth keeping, since
# anyone who minted some to trade with would otherwise be holding the wrong ones.
if [[ -n "$DWETH_REUSE" ]]; then
  TA="$DWETH_REUSE"; log "reusing dWETH ${TA}"
else
  log "deploying demo tokens"
  TA=$(create src/demo/DemoToken.sol:DemoToken "ScubaSwap Demo WETH" "dWETH" 18)
  [[ -n "$TA" ]] || die "dWETH deployment failed"
  log "dWETH ${TA}"
fi

if [[ -n "$DUSDC_REUSE" ]]; then
  TB="$DUSDC_REUSE"; log "reusing dUSDC ${TB}"
else
  TB=$(create src/demo/DemoToken.sol:DemoToken "ScubaSwap Demo USDC" "dUSDC" 6)
  [[ -n "$TB" ]] || die "dUSDC deployment failed"
  log "dUSDC ${TB}"
fi

if [[ -n "$AQUA_REUSE" ]]; then
  AQUA="$AQUA_REUSE"; log "reusing aqua ${AQUA}"
else
  log "deploying Aqua"
  AQUA=$(create node_modules/@1inch/aqua/src/Aqua.sol:Aqua)
  [[ -n "$AQUA" ]] || die "Aqua deployment failed"
  log "aqua ${AQUA}"
fi

for c in "$TA" "$TB" "$AQUA"; do
  [[ "$(cast code "$c" --rpc-url "$RPC" | wc -c)" -gt 100 ]] || die "no code at ${c}"
done

# Reused tokens must still be the right shape: the 18dp/6dp split is what the config
# uses to decide which side is sold, so a reused pair with swapped decimals would
# quietly invert the trade (F-15).
DEC_A=$(cast call "$TA" 'decimals()(uint8)' --rpc-url "$RPC" | awk '{print $1}')
DEC_B=$(cast call "$TB" 'decimals()(uint8)' --rpc-url "$RPC" | awk '{print $1}')
[[ "$DEC_A" == "18" && "$DEC_B" == "6" ]] \
  || die "expected dWETH 18dp and dUSDC 6dp, got ${DEC_A}dp and ${DEC_B}dp"

log "minting demo liquidity"
send "$TA" "mint(address,uint256)" "$DEPLOYER" "$MINT_WETHLIKE"
send "$TB" "mint(address,uint256)" "$DEPLOYER" "$MINT_USDCLIKE"

# MakerTraits requires tokenA < tokenB, and freshly deployed tokens land at arbitrary
# addresses — so sort rather than assume. Getting this wrong is not a revert: the
# amounts follow the tokens, so a mis-sorted pair ships the 6dp amount against the
# 18dp token and prices absurdly. See F-15.
if [[ "$(lower "$TA")" < "$(lower "$TB")" ]]; then
  T_A="$TA"; T_B="$TB"; S_A="$SHIP_WETHLIKE"; S_B="$SHIP_USDCLIKE"
else
  T_A="$TB"; T_B="$TA"; S_A="$SHIP_USDCLIKE"; S_B="$SHIP_WETHLIKE"
fi

# Ship the three programs on one router and write that router's config.
#
# Retried verbosely on failure because the first run swallows output: forge script is
# noisy on success and the useful line on failure is buried, so a silent first attempt
# plus a loud second one is more readable than either alone.
ship_programs() { # <router> <verifier> <out.json>
  local r=$1 v=$2 out=$3
  local env=(
    TOKEN_A="$T_A" TOKEN_B="$T_B" SHIP_A="$S_A" SHIP_B="$S_B"
    AQUA_ADDRESS="$AQUA" ROUTER_ADDRESS="$r"
    WORLD_ID_ACTION_PREFIX="$ACTION_PREFIX" WORLD_ID_VERIFIER="$v" WORLD_ID_RP_ID="$RP_ID_NUM"
    DEPLOYMENT_OUT="$out" DEPLOYMENT_RPC_URL="$RPC"
  )
  if ! env "${env[@]}" forge script script/DeployDemo.s.sol \
      --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_PK" >/dev/null 2>&1; then
    env "${env[@]}" forge script script/DeployDemo.s.sol \
      --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_PK"
    return 1
  fi
  [[ -f "$out" ]] || { printf 'expected %s to be written\n' "$out" >&2; return 1; }
}

# ---------------------------------------------------------------- routers
# Two routers, one per World ID environment.
#
# The verifier is a router immutable, and staging/production are separate identity
# trees — so a single router can only ever serve one of them. Deploying both is what
# makes it possible to test either flow without a redeploy: the frontend's toggle
# picks the environment, which selects both the router to quote against and the
# environment IDKit requests the proof from.
#
# Aqua and the demo tokens are shared. The programs are not: `aqua.ship` binds an
# order to a router, so each router needs its own three programs and its own balance.
ENVS=()
case "$WID_ENV" in
  both)       ENVS=(production staging) ;;
  production) ENVS=(production) ;;
  staging)    ENVS=(staging) ;;
esac

ROUTER_SUMMARY=""

for env in "${ENVS[@]}"; do
  case "$env" in
    production) V="$VERIFIER_PRODUCTION" ;;
    staging)    V="$VERIFIER_STAGING" ;;
  esac

  log "deploying ScubaSwapVMRouter (${env})"
  R=$(create src/routers/ScubaSwapVMRouter.sol:ScubaSwapVMRouter \
    "$AQUA" "$WETH" "$DEPLOYER" "ScubaSwapVM" "1" "$V" "$ACTION_PREFIX" "$RP_ID_NUM")
  [[ -n "$R" ]] || die "${env} router deployment failed"
  [[ "$(cast code "$R" --rpc-url "$RPC" | wc -c)" -gt 100 ]] || die "no code at ${R}"
  log "router ${R} (${env})"

  # Assert the router really carries the config we intended, read back from the
  # chain rather than trusted from what we passed in. The verifier especially: it
  # is what makes this router the ${env} one, and a mix-up would send every proof
  # request to the wrong World App.
  OC_PREFIX=$(cast call "$R" 'WORLD_ID_ACTION_PREFIX_HASH()(bytes32)' --rpc-url "$RPC" | awk '{print $1}')
  [[ "$OC_PREFIX" == "$PREFIX_HASH" ]] || die "${env} router prefix hash is ${OC_PREFIX}, expected ${PREFIX_HASH}"
  OC_RP=$(cast call "$R" 'WORLD_ID_RP_ID()(uint64)' --rpc-url "$RPC" | awk '{print $1}')
  [[ "$OC_RP" == "$RP_ID_NUM" ]] || die "${env} router rp id is ${OC_RP}, expected ${RP_ID_NUM}"
  OC_V=$(cast call "$R" 'WORLD_ID_VERIFIER()(address)' --rpc-url "$RPC" | awk '{print $1}')
  [[ "$(lower "$OC_V")" == "$(lower "$V")" ]] || die "${env} router verifier is ${OC_V}, expected ${V}"
  log "  config verified on-chain"

  OUT="deployments/worldchain-${env}.json"
  log "shipping programs (${env})"
  ship_programs "$R" "$V" "$OUT" || die "shipping failed for ${env}"

  ROUTER_SUMMARY="${ROUTER_SUMMARY}   router     ${R}  (${env})
"
done

# Merge from EVERY per-env file on disk, not just the ones this run produced.
#
# The per-env files are the source of truth and the merged config is derived. Merging
# only this run's output would mean deploying staging later silently dropped the
# production environment from the config — the router would still be on chain, but the
# frontend would lose its toggle and any proof bound to it.
#
# A leftover file from an unrelated deployment is not silently absorbed either: the
# merge asserts the shared fields match, so a stale file with different tokens fails
# loudly and tells you to delete it.
MERGE_ARGS=()
for f in deployments/worldchain-*.json; do
  [[ -f "$f" ]] || continue
  name=${f##*/worldchain-}; name=${name%.json}
  MERGE_ARGS+=("${name}=${f}")
done
[[ ${#MERGE_ARGS[@]} -gt 0 ]] || die "no per-environment configs were written"

log "merging deployment configs (${#MERGE_ARGS[@]} environment(s))"
node script/merge-deployments.mjs deployments/worldchain.json "${MERGE_ARGS[@]}" \
  || die "merging deployment configs failed"

log "verifying live quotes"
node script/smoke-quote.mjs "$RPC" deployments/worldchain.json || die "smoke test failed"

REMAINING=$(cast to-unit "$(cast balance "$DEPLOYER" --rpc-url "$RPC")" ether)
cat <<DONE

$(log "deployed to World Chain mainnet")
${ROUTER_SUMMARY}   aqua       ${AQUA}
   dWETH      ${TA}
   dUSDC      ${TB}
   prefix     ${ACTION_PREFIX}-*
   rp id      ${RP_ID_NUM}
   gas left   ${REMAINING} ETH
   config     deployments/worldchain.json

   Point the frontend at it:
     cp deployments/worldchain.json deployments/demo.json

   The header toggle switches environment. It selects BOTH the router and the
   environment IDKit requests the proof from, so set it before gearing up —
   switching discards the current proof, which the other tree cannot verify.
     production -> real Orb-verified World App
     staging    -> the simulator

   Anyone can mint demo tokens to trade:
     cast send ${TA} "mint(address,uint256)" <you> 10000000000000000000 \\
       --rpc-url ${RPC} --private-key <key>
DONE
