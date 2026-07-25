# ScubaSwap backend — RP signing

One endpoint. `POST /api/rp-signature` signs a World ID proof request so World
App will honour it; World ID **enforces** RP signatures for all 4.0 requests, so
without this the widget never produces a proof.

Proof *verification* is not here — it happens on-chain, inside the swap. That is
the whole point of the project, so there is deliberately no server-side verify
step to trust.

```
POST /api/rp-signature
  { "action": "scubaswap-connect", "ttl": 300 }

200 { "rp_id": "rp_…", "nonce": "0x00…", "created_at": …, "expires_at": …,
      "signature": "0x…" }        ← shaped for IDKit's rp_context
```

Field names are snake_case to match `rp_context` directly. `signRequest` returns
camelCase and calls the signature `sig`; that mapping is done here so the
mismatch never reaches the frontend.

## Why the signer is implemented, not imported

`@worldcoin/idkit-server` exports `signRequest`. We implement it instead, because
[the spec publishes deterministic test vectors](https://docs.world.org/world-id/idkit/signatures#test-vectors)
— including exact expected signature bytes — and those are only checkable against
an implementation that lets you inject the nonce and the clock. The SDK generates
both internally, so it can be smoke-tested but never *pinned*.

`test/vectors.test.mjs` reproduces all published vectors byte for byte, which
covers the things that are easy to get quietly wrong:

- **Keccak-256, not SHA3-256.** They differ only in padding, so SHA3 produces
  plausible garbage that fails verification with no clue why.
- **The EIP-191 prefix carries the decimal byte length** — `"49"` or `"81"`. A
  fixed-width or hex encoding yields a valid signature over the wrong digest,
  which World ID reads as impersonation.
- **`hashToField` is `keccak256 >> 8`** — the same reduction as `ByteHasher.sol`
  and the on-chain `action` parameter, where omitting the shift reverts
  `InvalidAction()` (FRICTION W-05).
- **Serialisation is `r ‖ s ‖ v` with `v = recovery_id + 27`.**

## Security properties, and why each exists

**The signing key is the app's identity.** Anyone holding it can mint requests
World App accepts as ScubaSwap. It lives in Secrets Manager, is fetched at cold
start, cached in memory only, and never logged or returned. It is deliberately
*not* a Lambda environment variable: those are readable by anyone with console
access and end up in CloudFormation history.

**This endpoint is a signing oracle.** Without `ALLOWED_ACTIONS` it would sign
any action a caller asked for, lending our RP identity to someone else's app. The
handler therefore **fails closed** when the allowlist is unset — returns 500
rather than defaulting to permissive. `test/handler.test.mjs` asserts that
specifically, because it is the failure mode that would go unnoticed.

**Responses must never be cached.** Each carries a single-use nonce that World ID
uses for replay protection; a shared cached response would hand the same nonce to
every caller. Enforced twice on purpose — `no-store` here and `CACHING_DISABLED`
on the CloudFront behaviour — because either control alone fails silently and
open.

**Failures are opaque to the client.** A signing error can be a malformed key, so
the response says `signing_failed` and nothing more. Tests assert the key appears
in no response, success or failure.

## Local development

```bash
cd backend && npm install
RP_SIGNING_KEY=0x<64 hex> ALLOWED_ACTIONS=scubaswap-connect npm run dev
npm test
```

The dev server enables CORS because Vite serves the SPA on another port. In
production there is none: CloudFront serves the SPA and `/api/*` from one origin.

## Deploy

See [`../infra/README.md`](../infra/README.md). The Lambda reads
`RP_SIGNING_KEY_SECRET_ID`, `ALLOWED_ACTIONS` and `RP_ID`.
