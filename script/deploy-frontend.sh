#!/usr/bin/env bash
#
# Build and publish the SPA to scubaswap.xyz.
#
#   ./script/deploy-frontend.sh            DRY RUN — builds and checks, uploads nothing
#   ./script/deploy-frontend.sh --execute  builds, uploads, invalidates
#
# The CDK stack creates the bucket but deliberately does not bundle the site: CDK asset
# staging applies its `exclude` patterns at every path depth, which once silently
# deleted `node_modules/viem/_esm/actions/test/` from the Lambda bundle. Keeping the SPA
# out of CDK and syncing it directly means the thing that gets uploaded is exactly the
# thing that was built and inspected.
#
# Requirements:
#   awscli, configured for the account that owns the stack
#   frontend/.env.local with VITE_WORLD_APP_ID set (it is compiled into the bundle)
#
# Optional:
#   STACK_NAME   defaults to ScubaSwapStack
#   AWS_REGION   defaults to us-east-1 (the stack is region-pinned: CloudFront only
#                accepts certificates issued there)
#
set -euo pipefail
cd "$(dirname "$0")/.."

STACK="${STACK_NAME:-ScubaSwapStack}"
REGION="${AWS_REGION:-us-east-1}"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

EXECUTE=0
[[ "${1:-}" == "--execute" ]] && EXECUTE=1

# ------------------------------------------------------- local preflight
# Everything checkable without AWS runs first, so a misconfigured build fails before
# any credential is used or any object is written.
log "preflight"

command -v aws >/dev/null || die "aws cli not found"
[[ -f deployments/demo.json ]] || die "deployments/demo.json is missing — nothing to point the site at"

# The single most dangerous mistake here: publishing a site whose config points at a
# local fork. chainId cannot catch it (an anvil fork of World Chain also reports 480),
# so check the recorded RPC.
CFG_RPC=$(python3 -c "import json;print(json.load(open('deployments/demo.json')).get('rpcUrl',''))")
case "$CFG_RPC" in
  ""|*127.0.0.1*|*localhost*)
    die "deployments/demo.json points at '${CFG_RPC:-<unset>}' — that is a local fork.
     Publish the mainnet config first:  cp deployments/worldchain.json deployments/demo.json" ;;
esac

ENVS=$(python3 -c "import json;print(','.join(json.load(open('deployments/demo.json')).get('environments',{})))")
[[ -n "$ENVS" ]] || die "deployments/demo.json has no environments — re-run the chain deploy"

# The app id is compiled into the bundle, so a missing one produces a site that looks
# fine and cannot gear up. Caught here rather than by a user at the QR step.
APP_ID=$(sed -n 's/^VITE_WORLD_APP_ID=\(app_[A-Za-z0-9_]*\).*/\1/p' frontend/.env.local 2>/dev/null | head -1)
[[ -n "$APP_ID" ]] || die "VITE_WORLD_APP_ID is not set in frontend/.env.local — the deployed site could not request a proof"

log "building"
(cd frontend && npm run build >/dev/null 2>&1) || { (cd frontend && npm run build); die "build failed"; }
[[ -f frontend/dist/index.html ]] || die "frontend/dist/index.html was not produced"

# Assert the built artefact really carries what we just checked, rather than trusting
# that the build read the env we read.
BUNDLE=$(ls frontend/dist/assets/index-*.js 2>/dev/null | head -1)
[[ -n "$BUNDLE" ]] || die "no index bundle in frontend/dist/assets"
grep -q "$APP_ID" "$BUNDLE" || die "the built bundle does not contain ${APP_ID} — check frontend/.env.local"
ROUTERS=$(python3 -c "
import json;d=json.load(open('deployments/demo.json'))
print(' '.join(v['router'] for v in d['environments'].values()))")
for r in $ROUTERS; do
  grep -qi "$r" "$BUNDLE" || die "the built bundle does not contain router ${r}"
done

SIZE=$(du -sh frontend/dist | awk '{print $1}')

# ------------------------------------------------------- stack lookup
log "reading stack outputs"
outputs=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output json 2>/dev/null) \
  || die "cannot read stack ${STACK} in ${REGION} — is the aws cli configured for the right account?"

get() { python3 -c "
import json,sys
for o in json.load(sys.stdin):
    if o['OutputKey']=='$1': print(o['OutputValue']); break"; }
BUCKET=$(printf '%s' "$outputs" | get SiteBucketName)
DIST=$(printf '%s' "$outputs" | get DistributionId)
SITE=$(printf '%s' "$outputs" | get SiteUrl)
[[ -n "$BUCKET" && -n "$DIST" ]] || die "stack outputs missing SiteBucketName/DistributionId"

cat <<PLAN

  ┌─ ScubaSwap SPA → ${SITE:-scubaswap.xyz} ────────────────────────────
  │ stack          ${STACK} (${REGION})
  │ bucket         ${BUCKET}
  │ distribution   ${DIST}
  │
  │ build          frontend/dist  (${SIZE})
  │ app id         ${APP_ID}
  │ chain rpc      ${CFG_RPC}
  │ environments   ${ENVS}
  │ routers        $(echo $ROUTERS | tr ' ' '\n' | sed '2,$s/^/                  /')
  └────────────────────────────────────────────────────────────────────

PLAN

if [[ $EXECUTE -eq 0 ]]; then
  log "DRY RUN — nothing uploaded. Re-run with --execute to publish."
  exit 0
fi

# ------------------------------------------------------- upload
# Two passes, because the caching rules differ and getting them the wrong way round is
# how a deploy appears to do nothing. Hashed assets are immutable and safe to cache for
# a year; index.html must never be cached, or browsers keep loading the old bundle and
# the new asset hashes are never requested.
log "uploading immutable assets"
aws s3 sync frontend/dist "s3://${BUCKET}" --region "$REGION" \
  --delete --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable" >/dev/null

log "uploading index.html"
aws s3 cp frontend/dist/index.html "s3://${BUCKET}/index.html" --region "$REGION" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8" >/dev/null

log "invalidating CloudFront"
ID=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --query 'Invalidation.Id' --output text)

cat <<DONE

$(log "published")
   site        ${SITE:-https://scubaswap.xyz}
   bucket      ${BUCKET}
   invalidation ${ID}

   Invalidation takes a minute or two to propagate. Verify with:
     curl -sI ${SITE:-https://scubaswap.xyz}/ | grep -i 'content-type\|cache-control'
     curl -s ${SITE:-https://scubaswap.xyz}/ | grep -o '<title>[^<]*</title>'
DONE
