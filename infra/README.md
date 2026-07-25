# ScubaSwap infrastructure

One CloudFront distribution fronting two origins:

```
                 ┌──────────────── CloudFront ────────────────┐
   your domain → │  /api/*  → API Gateway → Lambda (signer)   │
                 │  /*      → S3 (SPA, private via OAC)       │
                 └────────────────────────────────────────────┘
                                        │
                              Secrets Manager (signing key)
```

**Why one distribution rather than exposing API Gateway directly:** the SPA and
the API become same-origin, so there is **no CORS in production at all** — no
preflights, no allow-list drift between two services, one certificate, one
hostname to hand to judges. The cost is one CloudFront behaviour, which is
cheaper than the CORS configuration it replaces.

**Region: `us-east-1`.** Not arbitrary — CloudFront requires its ACM certificate
there, and keeping the whole stack in one region avoids a second cross-region
certificate stack for what is a demo.

## Deploy

```bash
cd infra && npm install
npx cdk bootstrap            # first time per account/region
npx cdk deploy
```

Then set the signing key — it is never in the template, in git, or in
CloudFormation history:

```bash
aws secretsmanager put-secret-value \
  --secret-id scubaswap/rp-signing-key \
  --secret-string '0xYOUR_64_HEX_KEY' \
  --region us-east-1
```

The stack prints `SetSigningKeyCommand` with this filled in. The Lambda caches
the key per container, so after rotating it either wait for cold starts or bump
an environment variable to force new ones.

Upload the SPA once it exists:

```bash
aws s3 sync ../frontend/dist "s3://$(aws cloudformation describe-stacks \
  --stack-name ScubaSwapStack --query 'Stacks[0].Outputs[?OutputKey==`SiteBucketName`].OutputValue' \
  --output text)" --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'
```

## Custom domain

The domain is optional, so the stack deploys today on the CloudFront hostname and
picks up a domain later without restructuring.

```bash
# Certificate must be in us-east-1 and validated before deploying.
aws acm request-certificate --domain-name scubaswap.example \
  --validation-method DNS --region us-east-1

npx cdk deploy \
  -c domainName=scubaswap.example \
  -c certificateArn=arn:aws:acm:us-east-1:…:certificate/…
```

Then point an ALIAS/CNAME at the distribution domain.

**Pass the domain context on every deploy, not just the first.** The certificate
and the alias records exist only while `hostedZoneName` (or `certificateArn`) is
present, so a later deploy that omits them — say, to change `allowedActions` —
synthesises a stack with no domain and CloudFormation dutifully deletes the alias
records and the certificate. The site goes dark with nothing in the output warning
you. The stack now throws if `domainName` is passed alone, but it cannot detect a
deploy that drops all three, so the habit is the real protection:

```bash
npx cdk deploy -c hostedZoneName=scubaswap.xyz -c allowedActions=scubaswap
```

Recovering is a redeploy with the context restored: the certificate is reissued and
DNS-validated automatically, and the alias records come back. Expect a few minutes
for issuance, and note ACM will refuse to delete the *old* certificate until
CloudFront finishes releasing it — 15-40 minutes, during which CloudFormation
retries and the stack sits in `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`.

## Configuration

`allowedActions` holds *prefixes*, not exact actions. World ID issues at most one
proof per `(identity, rp, action)`, so every dive names a fresh
`<prefix>-<timestamp>`; an exact-match allowlist would reject every real request.
It is still the control that stops this endpoint lending our RP identity to any
caller, so keep prefixes specific — `""` or `"a"` would defeat it.

| Context key | Default | Meaning |
| --- | --- | --- |
| `allowedActions` | `scubaswap` | Comma-separated allowlist of action **prefixes**. The signer **fails closed** if this is empty. |
| `rpId` | `rp_d8319d06a1241d73` | Echoed back as `rp_id` for convenience. |
| `hostedZoneName` | — | **The usual way to attach a domain.** Route53 zone name; the stack issues a DNS-validated certificate and writes the apex/`www` alias records itself. |
| `domainName` | `hostedZoneName` | Optional override when the site name differs from the zone name. Needs `hostedZoneName` *or* `certificateArn` — alone it is rejected. |
| `certificateArn` | — | Alternative to `hostedZoneName` for a domain not in Route53. Must be an `us-east-1` certificate; you write the DNS records yourself. |

## What the template enforces

Verified against the synthesized template, not just intended:

- `/api/*` uses **`CACHING_DISABLED`**. Load-bearing: every response carries a
  single-use nonce, and a cached one would be replayed across users. The handler
  also sets `no-store` — both, because either alone fails silently and open.
- `/api/*` uses **`ALL_VIEWER_EXCEPT_HOST_HEADER`**. `Host` must stay the API
  Gateway hostname or the request will not route.
- The Lambda's environment holds only a **secret id**, never the key.
- The S3 bucket blocks all public access; CloudFront reads it through OAC.
- The stage is throttled to 10 rps / 20 burst. This endpoint lends out our RP
  identity, so an open firehose is a reputational risk, not only a cost one.
- The secret is `RETAIN` on delete, so tearing down the stack does not destroy a
  key that had to be issued by hand.

## Cost

Comfortably inside free tier at demo volume: Lambda is a few hundred
invocations, CloudFront a few MB, S3 a few hundred KB. The only always-on charge
is Secrets Manager, about $0.40/month per secret.
